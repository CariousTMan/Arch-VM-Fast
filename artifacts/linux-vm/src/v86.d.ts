export interface V86FileLoader {
  url?: string;
  buffer?: ArrayBuffer | Blob;
  size?: number;
  async?: boolean;
  use_parts?: boolean;
}

export interface V86Options {
  wasm_path: string;
  memory_size: number;
  vga_memory_size?: number;
  screen_container?: HTMLElement | null;
  bios?: V86FileLoader;
  vga_bios?: V86FileLoader;
  cdrom?: V86FileLoader;
  hda?: V86FileLoader;
  hdb?: V86FileLoader;
  fda?: V86FileLoader;
  bzimage?: V86FileLoader;
  initrd?: V86FileLoader;
  cmdline?: string;
  initial_state?: V86FileLoader;
  filesystem?: { basefs?: V86FileLoader; baseurl?: string };
  network_relay_url?: string;
  autostart?: boolean;
  disable_keyboard?: boolean;
  disable_mouse?: boolean;
  disable_speaker?: boolean;
  acpi?: boolean;
  boot_order?: number;
}

export interface V86Instance {
  run(): void;
  stop(): void;
  restart(): void;
  destroy(): void;
  is_running(): boolean;
  save_state(): Promise<ArrayBuffer>;
  restore_state(state: ArrayBuffer): Promise<void>;
  keyboard_send_text(text: string): void;
  keyboard_send_scancodes(codes: number[]): void;
  keyboard_send_keys(codes: number[]): void;
  screen_make_screenshot(): HTMLCanvasElement;
  screen_set_scale(x: number, y: number): void;
  screen_go_fullscreen(): void;
  lock_mouse(): void;
  mouse_set_status(enabled: boolean): void;
  serial0_send(data: string): void;
  serial0_send_bytes(data: Uint8Array): void;
  add_listener(event: string, fn: (data: unknown) => void): void;
  remove_listener(event: string, fn: (data: unknown) => void): void;
}

export interface V86Constructor {
  new (options: V86Options): V86Instance;
}

declare global {
  interface Window {
    V86?: V86Constructor;
  }
}
