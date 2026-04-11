import { truncateToWidth } from '@mariozechner/pi-tui';
import {
  GREEN_DARK_FG,
  GREEN_FG,
  clamp,
  tint,
  usageColor,
  visibleWidth,
} from './utils';
import {
  computePanelWidths,
  framePanelBody,
  renderRow,
  SEPARATOR_WIDTH,
  type BuiltPanel,
} from './panel';

export type PlanWindow = {
  label: string;
  usedPercent: number;
  resetDescription?: string;
};

export type PlanSnapshot = {
  provider: string;
  displayName: string;
  windows: PlanWindow[];
};

type PlanRow = {
  label: string;
  labelColor: string;
  measure: number;
  renderValue: (valueWidth: number) => string;
};

type RemSegment = {
  tag: string;
  value: string;
};

function remTagLabel(label: string): string {
  const lower = label.trim().toLowerCase();
  if (lower === 'week') return 'wk';
  if (lower === 'month') return 'mo';
  return lower;
}

function padValueText(text: string, valueWidth: number): string {
  const deficit = valueWidth - visibleWidth(text);
  return deficit > 0 ? `${text}${' '.repeat(deficit)}` : text;
}

function buildRemLine(
  segments: RemSegment[],
  labelWidth: number,
  contentWidth: number,
): string | undefined {
  if (segments.length === 0) return undefined;

  const valueColumnStart = labelWidth + SEPARATOR_WIDTH;
  const valueWidth = Math.max(1, contentWidth - valueColumnStart);

  const joined = segments.map((s) => `${s.tag} ${s.value}`).join(' · ');
  const verboseText = `remaining: ${joined}`;

  // Wide form: drop the 'rem' label, spell out "remaining:" once,
  // aligned under the value column.
  if (visibleWidth(verboseText) <= valueWidth) {
    const prefix = ' '.repeat(valueColumnStart);
    const padded = padValueText(verboseText, valueWidth);
    return `${prefix}${tint(padded, GREEN_DARK_FG)}`;
  }

  // Compact form: keep the 'rem' label, omit the word "remaining".
  if (visibleWidth(joined) <= valueWidth) {
    return renderRow('rem', GREEN_DARK_FG, labelWidth, contentWidth, (vw) =>
      padValueText(joined, vw),
    );
  }

  // Narrow form: drop tag on every segment after the first.
  const narrowText = segments
    .map((s, i) => (i === 0 ? `${s.tag} ${s.value}` : s.value))
    .join(' · ');
  if (visibleWidth(narrowText) <= valueWidth) {
    return renderRow('rem', GREEN_DARK_FG, labelWidth, contentWidth, (vw) =>
      padValueText(narrowText, vw),
    );
  }

  // Very narrow form: drop the label entirely and left-flush the narrow text
  // across the full content width.
  if (visibleWidth(narrowText) <= contentWidth) {
    return tint(padValueText(narrowText, contentWidth), GREEN_DARK_FG);
  }

  // Extreme narrow: hide the row entirely.
  return undefined;
}

function compactWindowLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return 'plan';

  const wellKnownSuffix = trimmed.match(/\b(5h|week|month|pro|flash|credits|tokens)\b$/i)?.[1];
  if (wellKnownSuffix) {
    return wellKnownSuffix.toLowerCase();
  }

  const parts = trimmed.split(/\s+/);
  const last = parts.at(-1) || trimmed;
  if (last.length <= 10) return last.toLowerCase();
  if (trimmed.length <= 10) return trimmed.toLowerCase();
  return trimmed.slice(0, 10).toLowerCase();
}

function renderPlanBar(usedPercent: number, valueWidth: number): string {
  const used = Math.round(clamp(usedPercent, 0, 100));
  const remaining = Math.max(0, 100 - used);

  const longText = `${used}% used • ${remaining}% rem`;
  const shortText = `${used}%/${remaining}%`;
  const text = valueWidth >= longText.length + 5 ? longText : shortText;

  const desiredBar = 14;
  const minBar = 4;
  const availableForBar = valueWidth - text.length - 1;
  const barWidth = availableForBar >= minBar ? Math.min(desiredBar, availableForBar) : 0;

  const color = usageColor(used);
  const filled = barWidth > 0 ? Math.round((used / 100) * barWidth) : 0;
  const fill = tint('█'.repeat(Math.max(0, filled)), color);
  const empty = '░'.repeat(Math.max(0, barWidth - filled));
  const separator = barWidth > 0 ? ' ' : '';
  const textPart = tint(text, color);
  const composed = `${fill}${empty}${separator}${textPart}`;
  const deficit = valueWidth - visibleWidth(composed);
  return deficit > 0 ? `${composed}${' '.repeat(deficit)}` : composed;
}

export function buildPlanPanel(snapshot: PlanSnapshot, maxInner: number): BuiltPanel {
  const rightText = snapshot.displayName || snapshot.provider || 'plan';

  const rows: PlanRow[] =
    snapshot.windows.length > 0
      ? snapshot.windows.map((window, index) => ({
          label: compactWindowLabel(window.label),
          labelColor: index % 2 === 0 ? GREEN_FG : GREEN_DARK_FG,
          measure: 14 + 1 + `${Math.round(clamp(window.usedPercent, 0, 100))}% used • ${Math.max(0, 100 - Math.round(clamp(window.usedPercent, 0, 100)))}% rem`.length,
          renderValue: (valueWidth) => renderPlanBar(window.usedPercent, valueWidth),
        }))
      : [
          {
            label: 'status',
            labelColor: GREEN_FG,
            measure: 'unknown'.length,
            renderValue: (valueWidth) => truncateToWidth('unknown', valueWidth, '…', true),
          },
        ];

  const remSegments: RemSegment[] = snapshot.windows
    .filter((w) => typeof w.resetDescription === 'string' && w.resetDescription.length > 0)
    .map((w) => ({ tag: remTagLabel(w.label), value: w.resetDescription as string }));

  const labelWidth = Math.max(
    rows.reduce((max, row) => Math.max(max, row.label.length), 0),
    remSegments.length > 0 ? 'rem'.length : 0,
  );

  const remVerboseNatural =
    remSegments.length > 0
      ? visibleWidth(
          `remaining: ${remSegments.map((s) => `${s.tag} ${s.value}`).join(' · ')}`,
        )
      : 0;

  const naturalContentWidth = Math.max(
    rows.reduce(
      (max, row) => Math.max(max, labelWidth + SEPARATOR_WIDTH + row.measure),
      0,
    ),
    remSegments.length > 0 ? labelWidth + SEPARATOR_WIDTH + remVerboseNatural : 0,
  );

  const { inner, contentWidth } = computePanelWidths({
    title: 'PLAN',
    rightText,
    naturalContentWidth,
    maxInner,
    minInner: 28,
  });

  const bodyLines = rows.map((entry) =>
    renderRow(entry.label, entry.labelColor, labelWidth, contentWidth, entry.renderValue),
  );

  const remLine = buildRemLine(remSegments, labelWidth, contentWidth);
  if (remLine !== undefined) {
    bodyLines.push(remLine);
  }

  return framePanelBody({
    title: 'PLAN',
    rightText,
    bodyLines,
    inner,
    contentWidth,
  });
}
