/*
 * UI navigation state (mode + selected part). Persisted separately from the
 * setup autosave (`clrAutosave`) so the save-file schema stays untouched.
 */
import type { PartId } from './panels';
import type { Side } from '../core/parts';

export type UIMode = 'build' | 'tune' | 'replay';

export interface UIState {
  mode: UIMode;
  selectedPart: PartId | null;
  side: Side;   // ignored for chassis / steering
}

const KEY = 'clrUiState';

export function defaultUIState(): UIState {
  return { mode: 'build', selectedPart: 'chassis', side: 'R' };
}

export function loadUIState(): UIState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultUIState();
    const parsed = JSON.parse(raw);
    const mode: UIMode = parsed.mode === 'tune' ? 'tune'
      : parsed.mode === 'replay' ? 'replay' : 'build';
    return {
      mode,
      selectedPart: parsed.selectedPart ?? 'chassis',
      side: parsed.side === 'L' ? 'L' : 'R',
    };
  } catch { return defaultUIState(); }
}

export function saveUIState(s: UIState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full */ }
}
