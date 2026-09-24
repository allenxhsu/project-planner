export type Race = 'steel' | 'crystal' | 'chitin';
export type Skin = 'hud' | 'classic';
export type AppId =
  | 'heptabase'
  | 'idef0'
  | 'sysml'
  | 'project'
  | 'pyramid'
  | 'profiler'
  | 'hypermail'
  | 'metropolis'
  | 'habit'
  | 'bom';

export interface ThemeState {
  skin: Skin;
  race: Race;
  effects: 'on' | 'off';
}

export const RACES: Race[];
export const RACE_LABELS: Record<Race, string>;
export const APPS: AppId[];

export function getTheme(): ThemeState;
export function applyTheme(options?: { app?: AppId; root?: HTMLElement; macInset?: boolean }): ThemeState;
export function initTheme(options?: { app?: AppId; macInset?: boolean }): ThemeState;
export function setSkin(skin: Skin): ThemeState;
export function setRace(race: Race): ThemeState;
export function setEffects(on: boolean): ThemeState;
export function onThemeChange(callback: (state: ThemeState) => void): () => void;
export function detectMacDesktop(): boolean;
