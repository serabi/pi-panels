import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { getAgentDir, getSettingsListTheme } from '@mariozechner/pi-coding-agent';
import {
  decodeKittyPrintable,
  matchesKey,
  parseKey,
  type SettingItem,
  SettingsList,
  truncateToWidth,
} from '@mariozechner/pi-tui';
import { buildGitPanel, EMPTY_GIT_STATE, type GitInfo } from './git';
import { buildInfoPanel, type InfoSnapshot } from './info';
import { framePanelBody } from './panel';
import { buildPlanPanel, type PlanSnapshot } from './plan';
import { getPlanSnapshot, getUnknownPlanSnapshot } from './plan-usage';
import { formatCompactTokens, maxVisibleWidth, padVisible, visibleWidth } from './utils';

const SETTINGS_OVERLAY_MAX_INNER = 56;

function computeSettingsOverlayInner(bodyLines: string[], availableWidth: number): number {
  const maxInner = Math.max(24, Math.min(availableWidth - 2, SETTINGS_OVERLAY_MAX_INNER));
  return Math.max(
    24,
    Math.min(maxInner, Math.max(maxVisibleWidth(bodyLines), visibleWidth('─ STATUS PANELS ')) + 2),
  );
}

function getPrintableTypingKey(data: string): string | undefined {
  const kittyPrintable = decodeKittyPrintable(data);
  if (kittyPrintable && kittyPrintable !== ' ') {
    return kittyPrintable;
  }

  const parsed = parseKey(data);
  if (parsed && parsed.length === 1 && parsed !== ' ') {
    return parsed;
  }

  if (data.length === 1 && data !== ' ' && /^[\x21-\x7E]$/.test(data)) {
    return data;
  }

  return undefined;
}

const WIDGET_ID = 'status-panels';
const REFRESH_MS = 5000;
const TICK_MS = 250;
const GAP = ' ';
const CONFIG_PATH = join(getAgentDir(), 'state', 'extensions', 'status-panels', 'config.json');

const PANEL_DEFS = [
  { id: 'git', label: 'Git', defaultEnabled: true },
  { id: 'info', label: 'Info', defaultEnabled: true },
  { id: 'plan', label: 'Plan', defaultEnabled: true },
] as const;

type PanelId = (typeof PANEL_DEFS)[number]['id'];
type PanelState = Record<PanelId, boolean>;

type StatusPanelsConfig = {
  enabled: boolean;
  panels: PanelState;
};

type FooterData = {
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
};

function createPanelState(enabled: boolean): PanelState {
  return PANEL_DEFS.reduce((panels, panel) => {
    panels[panel.id] = enabled;
    return panels;
  }, {} as PanelState);
}

function createDefaultConfig(): StatusPanelsConfig {
  return {
    enabled: true,
    panels: createPanelState(true),
  };
}

function normalizeConfig(raw: unknown): StatusPanelsConfig {
  const defaults = createDefaultConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }

  const input = raw as { enabled?: unknown; panels?: Record<string, unknown> };
  const panels = { ...defaults.panels };

  for (const panel of PANEL_DEFS) {
    const value = input.panels?.[panel.id];
    if (typeof value === 'boolean') {
      panels[panel.id] = value;
    }
  }

  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled,
    panels,
  };
}

function loadConfig(): StatusPanelsConfig {
  if (!existsSync(CONFIG_PATH)) {
    return createDefaultConfig();
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return normalizeConfig(raw);
  } catch (error) {
    console.error(`Failed to load status panels config from ${CONFIG_PATH}:`, error);
    return createDefaultConfig();
  }
}

function saveConfig(config: StatusPanelsConfig): boolean {
  try {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.error(`Failed to save status panels config to ${CONFIG_PATH}:`, error);
    return false;
  }
}

function parseCount(raw: string): { behind: number; ahead: number } {
  const [behindRaw, aheadRaw] = raw.trim().split(/\s+/);
  return {
    behind: Number.parseInt(behindRaw || '0', 10) || 0,
    ahead: Number.parseInt(aheadRaw || '0', 10) || 0,
  };
}

function formatUsageSummary(ctx: ExtensionContext): string {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === 'message' && entry.message.role === 'assistant') {
      totalInput += entry.message.usage.input;
      totalOutput += entry.message.usage.output;
      totalCacheRead += entry.message.usage.cacheRead;
      totalCacheWrite += entry.message.usage.cacheWrite;
      totalCost += entry.message.usage.cost.total;
    }
  }

  const parts: string[] = [];
  if (totalInput) parts.push(`↑${formatCompactTokens(totalInput)}`);
  if (totalOutput) parts.push(`↓${formatCompactTokens(totalOutput)}`);
  if (totalCacheRead) parts.push(`R${formatCompactTokens(totalCacheRead)}`);
  if (totalCacheWrite) parts.push(`W${formatCompactTokens(totalCacheWrite)}`);

  const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
  if (totalCost || usingSubscription) {
    parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? ' (sub)' : ''}`);
  }

  return parts.join(' ') || 'no usage yet';
}

function combineSideBySide(left: string[], leftWidth: number, right: string[]): string[] {
  const rows = Math.max(left.length, right.length);
  const output: string[] = [];

  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? ' '.repeat(leftWidth);
    const r = right[i] ?? '';
    output.push(`${padVisible(l, leftWidth)}${GAP}${r}`);
  }

  return output;
}

function combinePanelsSideBySide(panels: Array<{ lines: string[]; width: number }>): string[] {
  if (panels.length === 0) return [];
  let combined = panels[0]!.lines;
  let combinedWidth = panels[0]!.width;

  for (const panel of panels.slice(1)) {
    combined = combineSideBySide(combined, combinedWidth, panel.lines);
    combinedWidth += visibleWidth(GAP) + panel.width;
  }

  return combined;
}

export default function statusPanelsExtension(pi: ExtensionAPI) {
  let ctxRef: ExtensionContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let config = loadConfig();
  let lastGitRefreshAt = 0;
  let lastPlanRefreshAt = 0;

  let gitState: GitInfo = EMPTY_GIT_STATE;

  let infoState: InfoSnapshot = {
    percent: null,
    tokens: null,
    contextWindow: 0,
    usageText: 'no usage yet',
    modelText: '(no model)',
    mcpText: null,
  };

  let planState: PlanSnapshot = getUnknownPlanSnapshot();
  let mcpStatusText: string | null = null;

  function isPanelEnabled(panelId: PanelId): boolean {
    return config.panels[panelId];
  }

  function checkboxValue(enabled: boolean): string {
    return enabled ? '[x]' : '[ ]';
  }

  function persistConfig(ctx?: ExtensionContext): boolean {
    const ok = saveConfig(config);
    if (!ok && ctx?.hasUI) {
      ctx.ui.notify('Failed to save status panels preferences', 'error');
    }
    return ok;
  }

  function applyConfig(ctx?: ExtensionContext) {
    if (ctx) ctxRef = ctx;

    if (!isPanelEnabled('plan')) {
      planState = getUnknownPlanSnapshot(ctx?.model);
    }

    if (!config.enabled) {
      stop();
      return;
    }

    stop();
    start();
  }

  function setMasterEnabled(nextEnabled: boolean, ctx?: ExtensionContext) {
    config = {
      enabled: nextEnabled,
      panels: createPanelState(nextEnabled),
    };
    persistConfig(ctx);
    applyConfig(ctx);
  }

  function setPanelEnabled(panelId: PanelId, nextEnabled: boolean, ctx?: ExtensionContext) {
    config = {
      ...config,
      panels: {
        ...config.panels,
        [panelId]: nextEnabled,
      },
    };
    persistConfig(ctx);
    applyConfig(ctx);
  }

  async function runGit(args: string[]): Promise<string | undefined> {
    try {
      const result = await pi.exec('git', args, { timeout: 2000 });
      if (result.code !== 0) return undefined;
      const value = result.stdout.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  function formatCwd(rawCwd: string): string {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home && rawCwd.startsWith(home)) {
      return `~${rawCwd.slice(home.length)}`;
    }
    return rawCwd;
  }

  async function readGitInfo(ctx: ExtensionContext): Promise<GitInfo> {
    const cwdDisplay = formatCwd(ctx.cwd);
    const inside = await runGit(['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') {
      return { ...EMPTY_GIT_STATE, cwd: cwdDisplay };
    }

    const topLevel = (await runGit(['rev-parse', '--show-toplevel'])) || '-';
    const worktree = topLevel.split('/').filter(Boolean).pop() || topLevel;

    const branch =
      (await runGit(['branch', '--show-current'])) ||
      (await runGit(['rev-parse', '--short', 'HEAD'])) ||
      '(detached)';

    const upstream = await runGit([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ]);

    if (!upstream) {
      return {
        inRepo: true,
        cwd: cwdDisplay,
        worktree,
        branch,
        tracking: '(no upstream)',
        ahead: 0,
        behind: 0,
      };
    }

    const countsRaw = await runGit(['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    const { behind, ahead } = parseCount(countsRaw || '0 0');

    return {
      inRepo: true,
      cwd: cwdDisplay,
      worktree,
      branch,
      tracking: upstream,
      ahead,
      behind,
    };
  }

  function readInfoState(ctx: ExtensionContext): InfoSnapshot {
    const usage = ctx.getContextUsage();

    const modelId = ctx.model?.id || '(no model)';
    const thinking = pi.getThinkingLevel();

    return {
      percent: usage?.percent ?? null,
      tokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? 0,
      usageText: formatUsageSummary(ctx),
      modelText: `${modelId} • ${thinking}`,
      mcpText: mcpStatusText,
    };
  }

  function buildTopBlock(safeWidth: number): string[] {
    const builders: Array<(maxInner: number) => { lines: string[]; width: number }> = [];

    if (isPanelEnabled('info')) {
      builders.push((maxInner) => buildInfoPanel(infoState, maxInner));
    }

    if (isPanelEnabled('git')) {
      builders.push((maxInner) => buildGitPanel(gitState, maxInner));
    }

    if (isPanelEnabled('plan')) {
      builders.push((maxInner) => buildPlanPanel(planState, maxInner));
    }

    if (builders.length === 0) {
      return [];
    }

    const naturalPanels = builders.map((build) => build(safeWidth - 2));
    const naturalWidth =
      naturalPanels.reduce((sum, panel) => sum + panel.width, 0) +
      visibleWidth(GAP) * Math.max(0, naturalPanels.length - 1);

    if (naturalWidth <= safeWidth) {
      return combinePanelsSideBySide(naturalPanels);
    }

    if (builders.length > 1) {
      const available = safeWidth - visibleWidth(GAP) * (builders.length - 1);
      const compactInner = Math.max(24, Math.floor(available / builders.length) - 2);
      const compactPanels = builders.map((build) => build(compactInner));
      const compactWidth =
        compactPanels.reduce((sum, panel) => sum + panel.width, 0) +
        visibleWidth(GAP) * Math.max(0, compactPanels.length - 1);

      if (compactWidth <= safeWidth) {
        return combinePanelsSideBySide(compactPanels);
      }
    }

    return naturalPanels.map((panel) => panel.lines).flat();
  }

  function installCustomFooter(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;

    (ctx.ui as typeof ctx.ui & {
      setFooter: (
        factory:
          | undefined
          | ((
              tui: { requestRender(): void },
              theme: unknown,
              footerData: FooterData,
            ) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
      ) => void;
    }).setFooter((_tui, _theme, footerData) => ({
      invalidate() {},
      render(_width: number) {
        const nextMcp = footerData.getExtensionStatuses().get('mcp') || null;
        if (nextMcp !== mcpStatusText) {
          mcpStatusText = nextMcp;
          if (ctxRef) {
            infoState = readInfoState(ctxRef);
            queueMicrotask(() => {
              if (config.enabled && ctxRef?.hasUI) {
                renderPanels();
              }
            });
          }
        }
        return [];
      },
    }));
  }

  function clearCustomFooter(ctx?: ExtensionContext | null) {
    if (!ctx?.hasUI) return;
    (ctx.ui as typeof ctx.ui & { setFooter: (factory: undefined) => void }).setFooter(undefined);
  }

  function renderPanels() {
    if (!config.enabled || !ctxRef?.hasUI) return;

    ctxRef.ui.setWidget(
      WIDGET_ID,
      (_tui, _theme) => ({
        invalidate() {},
        render(width: number) {
          const safeWidth = Math.max(1, width);
          const clampLines = (lines: string[]) =>
            lines.map((line) => truncateToWidth(line, safeWidth));

          return clampLines(buildTopBlock(safeWidth));
        },
      }),
      { placement: 'belowEditor' },
    );
  }

  async function refreshCore(force = false) {
    if (!ctxRef) return;
    const now = Date.now();
    if (!force && now - lastGitRefreshAt < REFRESH_MS) return;

    gitState = await readGitInfo(ctxRef);
    infoState = readInfoState(ctxRef);
    lastGitRefreshAt = now;
  }

  async function refreshPlan(force = false) {
    if (!ctxRef || !isPanelEnabled('plan')) return;
    const now = Date.now();
    if (!force && now - lastPlanRefreshAt < REFRESH_MS) return;

    planState = await getPlanSnapshot(ctxRef.model, force);
    if (planState.windows.length === 0) {
      planState = getUnknownPlanSnapshot(ctxRef.model);
    }
    lastPlanRefreshAt = now;
  }

  async function tick(forceCore = false) {
    if (!config.enabled || !ctxRef?.hasUI) return;

    await refreshCore(forceCore);
    await refreshPlan(forceCore);
    renderPanels();
  }

  function start() {
    if (!config.enabled || !ctxRef?.hasUI) return;
    installCustomFooter(ctxRef);
    if (timer) return;

    void tick(true);
    timer = setInterval(() => {
      void tick(false);
    }, TICK_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    clearCustomFooter(ctxRef);

    if (ctxRef?.hasUI) {
      ctxRef.ui.setWidget(WIDGET_ID, undefined);
    }
  }

  async function showSettingsOverlay(ctx: ExtensionContext): Promise<void> {
    ctxRef = ctx;

    const items: SettingItem[] = [
      {
        id: 'enabled',
        label: 'Show all panels',
        currentValue: checkboxValue(config.enabled),
        values: ['[x]', '[ ]'],
      },
      ...PANEL_DEFS.map((panel) => ({
        id: panel.id,
        label: panel.label,
        currentValue: checkboxValue(isPanelEnabled(panel.id)),
        values: ['[x]', '[ ]'],
      })),
    ];

    const settingsTheme = getSettingsListTheme();
    const maxVisibleItems = Math.min(items.length + 2, 10);
    const probeList = new SettingsList(
      items,
      maxVisibleItems,
      settingsTheme,
      () => {},
      () => {},
    );
    const probeLines = probeList.render(Math.max(8, SETTINGS_OVERLAY_MAX_INNER - 2));
    const overlayBodyLines = ['Choose which panels are visible', '', ...probeLines];
    const overlayWidth =
      computeSettingsOverlayInner(overlayBodyLines, SETTINGS_OVERLAY_MAX_INNER + 2) + 2;

    await ctx.ui.custom(
      (_tui, theme, _kb, done) => {
        const settingsList = new SettingsList(
          items,
          maxVisibleItems,
          settingsTheme,
          (id, newValue) => {
            const nextEnabled = newValue === '[x]';
            if (id === 'enabled') {
              setMasterEnabled(nextEnabled, ctx);
              for (const panel of PANEL_DEFS) {
                settingsList.updateValue(panel.id, checkboxValue(nextEnabled));
              }
              return;
            }

            setPanelEnabled(id as PanelId, nextEnabled, ctx);
          },
          () => done(undefined),
        );

        return {
          render(width: number) {
            const safeWidth = Math.max(24, width);
            const provisionalInner = Math.max(
              24,
              Math.min(safeWidth - 2, SETTINGS_OVERLAY_MAX_INNER),
            );
            const listLines = settingsList.render(Math.max(8, provisionalInner - 2));
            const bodyLines = [
              theme.fg('muted', 'Choose which panels are visible'),
              '',
              ...listLines,
            ];
            const naturalInner = computeSettingsOverlayInner(bodyLines, safeWidth);

            return framePanelBody({
              title: 'STATUS PANELS',
              bodyLines,
              inner: naturalInner,
            }).lines;
          },
          invalidate() {
            settingsList.invalidate();
          },
          handleInput(data: string) {
            const printableKey = getPrintableTypingKey(data);
            if (
              printableKey &&
              !matchesKey(data, 'escape') &&
              !matchesKey(data, 'return') &&
              !matchesKey(data, 'up') &&
              !matchesKey(data, 'down') &&
              !matchesKey(data, 'left') &&
              !matchesKey(data, 'right')
            ) {
              done(undefined);
              queueMicrotask(() => ctx.ui.pasteToEditor(printableKey));
              return;
            }

            settingsList.handleInput?.(data);
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: 'center',
          width: overlayWidth,
        },
      },
    );
  }

  pi.registerCommand('status-panels', {
    description: 'Open status panel settings, or use /status-panels [on|off]',
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const mode = (args || '').trim().toLowerCase();

      if (mode === '' || mode === 'settings') {
        await showSettingsOverlay(ctx);
        return;
      }

      if (!['on', 'off'].includes(mode)) {
        ctx.ui.notify('Usage: /status-panels [on|off]', 'warning');
        return;
      }

      const nextEnabled = mode === 'on';
      setMasterEnabled(nextEnabled, ctx);
      ctx.ui.notify(nextEnabled ? 'Status panels visible' : 'Status panels hidden', 'info');
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    config = loadConfig();
    applyConfig(ctx);
  });

  pi.on('session_switch', async (_event, ctx) => {
    config = loadConfig();
    applyConfig(ctx);
  });

  pi.on('turn_end', async (_event, ctx) => {
    ctxRef = ctx;
    if (!config.enabled) return;
    void tick(true);
  });

  pi.on('model_select', async (_event, ctx) => {
    ctxRef = ctx;
    if (!config.enabled) return;
    infoState = readInfoState(ctx);
    await refreshPlan(true);
    renderPanels();
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    ctxRef = ctx;
    stop();
  });
}
