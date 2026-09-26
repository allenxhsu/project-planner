export type Race = 'steel' | 'crystal' | 'chitin';
export type Skin = 'hud' | 'mac';
/** The macOS skin's appearance preference. */
export type Appearance = 'system' | 'light' | 'dark';
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
  /** The HUD palette. */
  race: Race;
  effects: 'on' | 'off';
  /** The macOS appearance preference. */
  appearance: Appearance;
  /** The appearance the macOS skin shows once 'system' is resolved. */
  mode: 'light' | 'dark';
}

export const SKINS: Skin[];
export const SKIN_LABELS: Record<Skin, string>;
export const RACES: Race[];
export const RACE_LABELS: Record<Race, string>;
export const APPEARANCES: Appearance[];
export const APPEARANCE_LABELS: Record<Appearance, string>;
export const APPS: AppId[];

export function getTheme(): ThemeState;
export function applyTheme(options?: { app?: AppId; root?: HTMLElement; macInset?: boolean }): ThemeState;
export function initTheme(options?: { app?: AppId; macInset?: boolean }): ThemeState;
export function setSkin(skin: Skin): ThemeState;
export function setRace(race: Race): ThemeState;
export function setEffects(on: boolean): ThemeState;
export function setAppearance(appearance: Appearance): ThemeState;
export function onThemeChange(callback: (state: ThemeState) => void): () => void;
export function detectMacDesktop(): boolean;
