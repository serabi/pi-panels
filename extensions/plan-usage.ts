import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PlanWindow = {
  label: string;
  usedPercent: number;
  resetDescription?: string;
  resetAt?: string;
};

export type PlanSnapshot = {
  provider: string;
  displayName: string;
  windows: PlanWindow[];
  statusText?: string;
};

type PiModel = {
  provider?: string;
  id?: string;
};

type SupportedProvider = 'anthropic' | 'copilot' | 'gemini' | 'antigravity' | 'codex' | 'opencode' | 'opencode-go';

const API_TIMEOUT_MS = 5000;

const DISPLAY_NAMES: Record<SupportedProvider, string> = {
  anthropic: 'Claude Plan',
  copilot: 'Copilot Plan',
  gemini: 'Gemini Plan',
  antigravity: 'Antigravity',
  codex: 'Codex Plan',
  opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go',
};

const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const;

const ANTIGRAVITY_HEADERS = {
  'User-Agent': 'antigravity/1.11.5 darwin/arm64',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': JSON.stringify({
    ideType: 'IDE_UNSPECIFIED',
    platform: 'PLATFORM_UNSPECIFIED',
    pluginType: 'GEMINI',
  }),
};

const ANTIGRAVITY_HIDDEN_MODELS = new Set(['tab_flash_lite_preview']);

const cache = new Map<SupportedProvider, { fetchedAt: number; snapshot: PlanSnapshot }>();

function formatReset(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0) return 'now';

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function createTimeoutController(timeoutMs: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    controller,
    clear: () => clearTimeout(timeoutId),
  };
}

function readJson(path: string): any | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function detectProvider(model: PiModel | undefined): SupportedProvider | undefined {
  if (!model) return undefined;
  const providerValue = model.provider?.toLowerCase() || '';
  const idValue = model.id?.toLowerCase() || '';

  if (providerValue.includes('anthropic') || idValue.includes('claude')) return 'anthropic';
  if (providerValue.includes('copilot') || providerValue.includes('github')) return 'copilot';
  if (providerValue.includes('antigravity') || idValue.includes('antigravity')) return 'antigravity';
  if (
    providerValue.includes('google') ||
    providerValue.includes('gemini') ||
    idValue.includes('gemini')
  ) {
    return 'gemini';
  }
  if (providerValue.includes('codex')) return 'codex';
  if (providerValue === 'opencode') return 'opencode';
  if (providerValue === 'opencode-go') return 'opencode-go';
  return undefined;
}

function emptySnapshot(provider?: SupportedProvider): PlanSnapshot {
  return {
    provider: provider || 'plan',
    displayName: provider ? DISPLAY_NAMES[provider] : 'Plan',
    windows: [],
  };
}

function normalizeUsedPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function toUsedPercentFromRemaining(remainingFraction: number): number {
  const fraction = Number.isFinite(remainingFraction) ? remainingFraction : 1;
  return normalizeUsedPercent((1 - fraction) * 100);
}

function loadAnthropicTokenCandidates(): string[] {
  const candidates: string[] = [];

  const envToken = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (envToken) candidates.push(envToken);

  try {
    const keychainData = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (keychainData) {
      const parsed = JSON.parse(keychainData);
      const scopes = parsed?.claudeAiOauth?.scopes || [];
      if (Array.isArray(scopes) && scopes.includes('user:profile')) {
        const token = parsed?.claudeAiOauth?.accessToken;
        if (typeof token === 'string' && token.length > 0) candidates.push(token);
      }
    }
  } catch {
    // ignore
  }

  const piAuth = readJson(join(homedir(), '.pi', 'agent', 'auth.json'));
  if (typeof piAuth?.anthropic?.access === 'string') candidates.push(piAuth.anthropic.access);

  return candidates;
}

async function tryAnthropicToken(token: string): Promise<PlanSnapshot | undefined> {
  const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.anthropic.com/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
      },
      signal: controller.signal,
    });
    clear();
    if (res.status === 401 || res.status === 403) return undefined;
    if (!res.ok) return emptySnapshot('anthropic');

    const data = (await res.json()) as {
      five_hour?: { utilization?: number; resets_at?: string };
      seven_day?: { utilization?: number; resets_at?: string };
      extra_usage?: {
        is_enabled?: boolean;
        used_credits?: number;
        monthly_limit?: number;
        utilization?: number;
      };
    };

    const windows: PlanWindow[] = [];

    if (data.five_hour?.utilization !== undefined) {
      const resetAt = data.five_hour.resets_at ? new Date(data.five_hour.resets_at) : undefined;
      windows.push({
        label: '5h',
        usedPercent: normalizeUsedPercent(data.five_hour.utilization),
        resetDescription: resetAt ? formatReset(resetAt) : undefined,
        resetAt: resetAt?.toISOString(),
      });
    }

    if (data.seven_day?.utilization !== undefined) {
      const resetAt = data.seven_day.resets_at ? new Date(data.seven_day.resets_at) : undefined;
      windows.push({
        label: 'Week',
        usedPercent: normalizeUsedPercent(data.seven_day.utilization),
        resetDescription: resetAt ? formatReset(resetAt) : undefined,
        resetAt: resetAt?.toISOString(),
      });
    }

    if (data.extra_usage?.is_enabled && data.extra_usage.utilization !== undefined) {
      windows.push({
        label: 'Extra',
        usedPercent: normalizeUsedPercent(data.extra_usage.utilization),
      });
    }

    return {
      provider: 'anthropic',
      displayName: DISPLAY_NAMES.anthropic,
      windows,
    };
  } catch {
    clear();
    return undefined;
  }
}

async function fetchAnthropicUsage(): Promise<PlanSnapshot> {
  const candidates = loadAnthropicTokenCandidates();
  for (const token of candidates) {
    const result = await tryAnthropicToken(token);
    if (result) return result;
  }
  return emptySnapshot('anthropic');
}

type CopilotHostEntry = {
  oauth_token?: string;
  user_token?: string;
  github_token?: string;
  token?: string;
};

function getTokenFromHostEntry(entry: CopilotHostEntry | undefined): string | undefined {
  if (!entry) return undefined;
  for (const key of ['oauth_token', 'user_token', 'github_token', 'token'] as const) {
    const value = entry[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function loadCopilotToken(): string | undefined {
  const envToken = (
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.COPILOT_TOKEN
  )?.trim();
  if (envToken) return envToken;

  const piAuth = readJson(join(homedir(), '.pi', 'agent', 'auth.json'));
  const piToken = piAuth?.['github-copilot']?.refresh || piAuth?.['github-copilot']?.access;
  if (typeof piToken === 'string' && piToken.length > 0) return piToken;

  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const legacyPaths = [
    join(configHome, 'github-copilot', 'hosts.json'),
    join(homedir(), '.github-copilot', 'hosts.json'),
  ];

  for (const hostsPath of legacyPaths) {
    const data = readJson(hostsPath);
    if (!data || typeof data !== 'object') continue;
    const entries = data as Record<string, CopilotHostEntry>;
    const normalized: Record<string, CopilotHostEntry> = {};
    for (const [host, entry] of Object.entries(entries)) {
      normalized[host.toLowerCase()] = entry;
    }
    const preferred =
      getTokenFromHostEntry(normalized['github.com']) ||
      getTokenFromHostEntry(normalized['api.github.com']);
    if (preferred) return preferred;
    for (const entry of Object.values(normalized)) {
      const token = getTokenFromHostEntry(entry);
      if (token) return token;
    }
  }

  return undefined;
}

async function fetchCopilotUsage(): Promise<PlanSnapshot> {
  const token = loadCopilotToken();
  if (!token) return emptySnapshot('copilot');

  const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.github.com/copilot_internal/user', {
      headers: {
        'Editor-Version': 'vscode/1.96.2',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'X-Github-Api-Version': '2025-04-01',
        Accept: 'application/json',
        Authorization: `token ${token}`,
      },
      signal: controller.signal,
    });
    clear();
    if (!res.ok) return emptySnapshot('copilot');

    const data = (await res.json()) as {
      quota_reset_date_utc?: string;
      quota_snapshots?: {
        premium_interactions?: {
          percent_remaining?: number;
        };
      };
    };

    const windows: PlanWindow[] = [];
    const resetDate = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
    const percentRemaining = data.quota_snapshots?.premium_interactions?.percent_remaining;
    if (typeof percentRemaining === 'number') {
      windows.push({
        label: 'Month',
        usedPercent: normalizeUsedPercent(100 - percentRemaining),
        resetDescription: resetDate ? formatReset(resetDate) : undefined,
        resetAt: resetDate?.toISOString(),
      });
    }

    return {
      provider: 'copilot',
      displayName: DISPLAY_NAMES.copilot,
      windows,
    };
  } catch {
    clear();
    return emptySnapshot('copilot');
  }
}

function loadGeminiToken(): string | undefined {
  const envToken = (
    process.env.GOOGLE_GEMINI_CLI_OAUTH_TOKEN ||
    process.env.GOOGLE_GEMINI_CLI_ACCESS_TOKEN ||
    process.env.GEMINI_OAUTH_TOKEN ||
    process.env.GOOGLE_GEMINI_OAUTH_TOKEN
  )?.trim();
  if (envToken) return envToken;

  const piAuth = readJson(join(homedir(), '.pi', 'agent', 'auth.json'));
  if (typeof piAuth?.['google-gemini-cli']?.access === 'string') {
    return piAuth['google-gemini-cli'].access;
  }

  const geminiCreds = readJson(join(homedir(), '.gemini', 'oauth_creds.json'));
  if (typeof geminiCreds?.access_token === 'string') return geminiCreds.access_token;

  return undefined;
}

async function fetchGeminiUsage(): Promise<PlanSnapshot> {
  const token = loadGeminiToken();
  if (!token) return emptySnapshot('gemini');

  const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
  try {
    const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });
    clear();
    if (!res.ok) return emptySnapshot('gemini');

    const data = (await res.json()) as {
      buckets?: Array<{
        modelId?: string;
        remainingFraction?: number;
      }>;
    };

    const quotas: Record<string, number> = {};
    for (const bucket of data.buckets || []) {
      const model = bucket.modelId || 'unknown';
      const frac = bucket.remainingFraction ?? 1;
      if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
    }

    let proMin = 1;
    let flashMin = 1;
    let hasProModel = false;
    let hasFlashModel = false;

    for (const [model, frac] of Object.entries(quotas)) {
      if (model.toLowerCase().includes('pro')) {
        hasProModel = true;
        if (frac < proMin) proMin = frac;
      }
      if (model.toLowerCase().includes('flash')) {
        hasFlashModel = true;
        if (frac < flashMin) flashMin = frac;
      }
    }

    const windows: PlanWindow[] = [];
    if (hasProModel) windows.push({ label: 'Pro', usedPercent: toUsedPercentFromRemaining(proMin) });
    if (hasFlashModel) {
      windows.push({ label: 'Flash', usedPercent: toUsedPercentFromRemaining(flashMin) });
    }

    return {
      provider: 'gemini',
      displayName: DISPLAY_NAMES.gemini,
      windows,
    };
  } catch {
    clear();
    return emptySnapshot('gemini');
  }
}

type CodexRateWindow = {
  reset_at?: number;
  limit_window_seconds?: number;
  used_percent?: number;
};

type CodexRateLimit = {
  primary_window?: CodexRateWindow;
  secondary_window?: CodexRateWindow;
};

type CodexAdditionalRateLimit = {
  limit_name?: string;
  metered_feature?: string;
  rate_limit?: CodexRateLimit;
};

function loadCodexCredentials(): { accessToken?: string; accountId?: string } {
  const envAccessToken = (
    process.env.OPENAI_CODEX_OAUTH_TOKEN ||
    process.env.OPENAI_CODEX_ACCESS_TOKEN ||
    process.env.CODEX_OAUTH_TOKEN ||
    process.env.CODEX_ACCESS_TOKEN
  )?.trim();
  const envAccountId = (process.env.OPENAI_CODEX_ACCOUNT_ID || process.env.CHATGPT_ACCOUNT_ID)?.trim();
  if (envAccessToken) {
    return { accessToken: envAccessToken, accountId: envAccountId || undefined };
  }

  const piAuth = readJson(join(homedir(), '.pi', 'agent', 'auth.json'));
  if (typeof piAuth?.['openai-codex']?.access === 'string') {
    return {
      accessToken: piAuth['openai-codex'].access,
      accountId: piAuth['openai-codex'].accountId,
    };
  }

  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const legacyAuth = readJson(join(codexHome, 'auth.json'));
  if (typeof legacyAuth?.OPENAI_API_KEY === 'string') {
    return { accessToken: legacyAuth.OPENAI_API_KEY };
  }
  if (typeof legacyAuth?.tokens?.access_token === 'string') {
    return {
      accessToken: legacyAuth.tokens.access_token,
      accountId: legacyAuth.tokens.account_id,
    };
  }

  return {};
}

function codexWindowLabel(windowSeconds?: number, fallbackWindowSeconds?: number): string {
  const safeWindowSeconds =
    typeof windowSeconds === 'number' && windowSeconds > 0
      ? windowSeconds
      : typeof fallbackWindowSeconds === 'number' && fallbackWindowSeconds > 0
        ? fallbackWindowSeconds
        : 0;
  if (!safeWindowSeconds) return '0h';
  const windowHours = Math.round(safeWindowSeconds / 3600);
  if (windowHours >= 144) return 'Week';
  if (windowHours >= 24) return 'Day';
  return `${windowHours}h`;
}

function pushCodexWindow(
  windows: PlanWindow[],
  prefix: string | undefined,
  window: CodexRateWindow | undefined,
  fallbackWindowSeconds?: number,
): void {
  if (!window) return;
  const resetDate = window.reset_at ? new Date(window.reset_at * 1000) : undefined;
  const label = codexWindowLabel(window.limit_window_seconds, fallbackWindowSeconds);
  windows.push({
    label: prefix ? `${prefix} ${label}` : label,
    usedPercent: normalizeUsedPercent(window.used_percent || 0),
    resetDescription: resetDate ? formatReset(resetDate) : undefined,
    resetAt: resetDate?.toISOString(),
  });
}

function addCodexRateWindows(
  windows: PlanWindow[],
  rateLimit: CodexRateLimit | undefined,
  prefix?: string,
): void {
  pushCodexWindow(windows, prefix, rateLimit?.primary_window, 10800);
  pushCodexWindow(windows, prefix, rateLimit?.secondary_window, 86400);
}

async function fetchCodexUsage(): Promise<PlanSnapshot> {
  const { accessToken, accountId } = loadCodexCredentials();
  if (!accessToken) return emptySnapshot('codex');

  const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;

    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers,
      signal: controller.signal,
    });
    clear();
    if (!res.ok) return emptySnapshot('codex');

    const data = (await res.json()) as {
      rate_limit?: CodexRateLimit;
      additional_rate_limits?: CodexAdditionalRateLimit[];
    };

    const windows: PlanWindow[] = [];
    addCodexRateWindows(windows, data.rate_limit);
    if (Array.isArray(data.additional_rate_limits)) {
      for (const entry of data.additional_rate_limits) {
        if (!entry || typeof entry !== 'object') continue;
        const prefix =
          typeof entry.limit_name === 'string' && entry.limit_name.trim().length > 0
            ? entry.limit_name.trim()
            : typeof entry.metered_feature === 'string' && entry.metered_feature.trim().length > 0
              ? entry.metered_feature.trim()
              : 'Additional';
        addCodexRateWindows(windows, entry.rate_limit, prefix);
      }
    }

    return {
      provider: 'codex',
      displayName: DISPLAY_NAMES.codex,
      windows,
    };
  } catch {
    clear();
    return emptySnapshot('codex');
  }
}

type AntigravityAuth = {
  access?: string;
  accessToken?: string;
  token?: string;
  key?: string;
  projectId?: string;
  project?: string;
};

function loadAntigravityAuth(): AntigravityAuth | undefined {
  const envProjectId =
    (process.env.GOOGLE_ANTIGRAVITY_PROJECT_ID || process.env.GOOGLE_ANTIGRAVITY_PROJECT)?.trim();
  const envToken = (
    process.env.GOOGLE_ANTIGRAVITY_OAUTH_TOKEN || process.env.ANTIGRAVITY_OAUTH_TOKEN
  )?.trim();
  if (envToken) return { token: envToken, projectId: envProjectId || undefined };

  const envApiKey = (process.env.GOOGLE_ANTIGRAVITY_API_KEY || process.env.ANTIGRAVITY_API_KEY)?.trim();
  if (envApiKey) {
    try {
      const parsed = JSON.parse(envApiKey) as { token?: string; projectId?: string };
      if (parsed?.token) {
        return { token: parsed.token, projectId: parsed.projectId || envProjectId || undefined };
      }
    } catch {
      // ignore
    }
    return { token: envApiKey, projectId: envProjectId || undefined };
  }

  const piAuth = readJson(join(homedir(), '.pi', 'agent', 'auth.json'));
  const entry = piAuth?.['google-antigravity'];
  if (!entry) return undefined;
  if (typeof entry === 'string') return { token: entry };
  return {
    access: entry.access,
    accessToken: entry.accessToken,
    token: entry.token,
    key: entry.key,
    projectId: entry.projectId ?? entry.project,
  };
}

function resolveAntigravityToken(auth: AntigravityAuth | undefined): string | undefined {
  return auth?.access ?? auth?.accessToken ?? auth?.token ?? auth?.key;
}

function parseResetTime(value?: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

async function fetchAntigravityQuota(
  endpoint: string,
  token: string,
  projectId?: string,
): Promise<{ data?: any; status?: number }> {
  const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
  try {
    const payload = projectId ? { project: projectId } : {};
    const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clear();
    if (!res.ok) return { status: res.status };
    return { data: await res.json() };
  } catch {
    clear();
    return {};
  }
}

async function fetchAntigravityUsage(): Promise<PlanSnapshot> {
  const auth = loadAntigravityAuth();
  const token = resolveAntigravityToken(auth);
  if (!token) return emptySnapshot('antigravity');

  let data: any | undefined;
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    const result = await fetchAntigravityQuota(endpoint, token, auth?.projectId);
    if (result.data) {
      data = result.data;
      break;
    }
  }
  if (!data) return emptySnapshot('antigravity');

  const modelByName = new Map<string, { name: string; remainingFraction: number; resetAt?: Date }>();
  for (const [modelId, model] of Object.entries<any>(data.models ?? {})) {
    if (model?.isInternal) continue;
    if (modelId && ANTIGRAVITY_HIDDEN_MODELS.has(String(modelId).toLowerCase())) continue;
    const name = model?.displayName ?? modelId ?? model?.model ?? 'unknown';
    if (!name || ANTIGRAVITY_HIDDEN_MODELS.has(String(name).toLowerCase())) continue;

    const remainingFraction = model?.quotaInfo?.remainingFraction ?? 1;
    const resetAt = parseResetTime(model?.quotaInfo?.resetTime);
    const existing = modelByName.get(name);
    if (!existing || remainingFraction < existing.remainingFraction) {
      modelByName.set(name, { name, remainingFraction, resetAt });
      continue;
    }
    if (!existing.resetAt && resetAt) {
      modelByName.set(name, { ...existing, resetAt });
    }
  }

  const windows = Array.from(modelByName.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((model) => ({
      label: model.name,
      usedPercent: toUsedPercentFromRemaining(model.remainingFraction),
      resetDescription: model.resetAt ? formatReset(model.resetAt) : undefined,
      resetAt: model.resetAt?.toISOString(),
    }));

  return {
    provider: 'antigravity',
    displayName: DISPLAY_NAMES.antigravity,
    windows,
  };
}

async function fetchOpencodeUsage(): Promise<PlanSnapshot> {
  return {
    provider: 'opencode',
    displayName: DISPLAY_NAMES.opencode,
    windows: [],
    statusText: 'Pay-as-you-go',
  };
}

type OpencodeGoWindowRaw = {
  label: string;
  usagePercent: number;
  resetInSec: number;
};

function extractOpencodeGoWindow(html: string, key: string): OpencodeGoWindowRaw | undefined {
  const pctFirst = new RegExp(
    `${key}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:(\\d+)[^}]*resetInSec:(\\d+)[^}]*\\}`,
  ).exec(html);
  const resetFirst = new RegExp(
    `${key}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:(\\d+)[^}]*usagePercent:(\\d+)[^}]*\\}`,
  ).exec(html);

  let usagePercent: number | undefined;
  let resetInSec: number | undefined;

  if (pctFirst) {
    usagePercent = Number(pctFirst[1]);
    resetInSec = Number(pctFirst[2]);
  } else if (resetFirst) {
    resetInSec = Number(resetFirst[1]);
    usagePercent = Number(resetFirst[2]);
  }

  if (
    usagePercent !== undefined &&
    resetInSec !== undefined &&
    Number.isFinite(usagePercent) &&
    Number.isFinite(resetInSec)
  ) {
    return { label: key.replace('Usage', ''), usagePercent, resetInSec };
  }
  return undefined;
}

async function fetchOpencodeGoUsage(): Promise<PlanSnapshot> {
  const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
  const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();

  if (!workspaceId || !authCookie) {
    return {
      provider: 'opencode-go',
      displayName: DISPLAY_NAMES['opencode-go'],
      windows: [],
      statusText: '5h $12 · wk $30 · mo $60',
    };
  }

  const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);
  try {
    const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Cookie: `auth=${authCookie}`,
        Accept: 'text/html',
      },
      signal: controller.signal,
    });
    clear();

    if (!res.ok) {
      return {
        provider: 'opencode-go',
        displayName: DISPLAY_NAMES['opencode-go'],
        windows: [],
        statusText: '5h $12 · wk $30 · mo $60',
      };
    }

    const html = await res.text();

    const windows: PlanWindow[] = [];
    for (const key of ['rollingUsage', 'weeklyUsage', 'monthlyUsage'] as const) {
      const raw = extractOpencodeGoWindow(html, key);
      if (!raw) continue;
      const resetAt = new Date(Date.now() + raw.resetInSec * 1000);
      windows.push({
        label: raw.label,
        usedPercent: normalizeUsedPercent(raw.usagePercent),
        resetDescription: formatReset(resetAt),
        resetAt: resetAt.toISOString(),
      });
    }

    if (windows.length > 0) {
      return {
        provider: 'opencode-go',
        displayName: DISPLAY_NAMES['opencode-go'],
        windows,
      };
    }
  } catch {
    clear();
  }

  return {
    provider: 'opencode-go',
    displayName: DISPLAY_NAMES['opencode-go'],
    windows: [],
    statusText: '5h $12 · wk $30 · mo $60',
  };
}

async function fetchForProvider(provider: SupportedProvider): Promise<PlanSnapshot> {
  switch (provider) {
    case 'anthropic':
      return fetchAnthropicUsage();
    case 'copilot':
      return fetchCopilotUsage();
    case 'gemini':
      return fetchGeminiUsage();
    case 'antigravity':
      return fetchAntigravityUsage();
    case 'codex':
      return fetchCodexUsage();
    case 'opencode':
      return fetchOpencodeUsage();
    case 'opencode-go':
      return fetchOpencodeGoUsage();
  }
}

export function getUnknownPlanSnapshot(model?: PiModel): PlanSnapshot {
  const provider = detectProvider(model);
  return emptySnapshot(provider);
}

export async function getPlanSnapshot(model: PiModel | undefined, force = false): Promise<PlanSnapshot> {
  const provider = detectProvider(model);
  if (!provider) return emptySnapshot();

  const cached = cache.get(provider);
  const now = Date.now();
  if (!force && cached && now - cached.fetchedAt < 60_000) {
    return cached.snapshot;
  }

  const snapshot = await fetchForProvider(provider);
  cache.set(provider, { fetchedAt: now, snapshot });
  return snapshot;
}
