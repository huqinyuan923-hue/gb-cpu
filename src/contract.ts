/** GB 模拟器 · 共享契约 v1.0（冻结）。禁止修改；缺陷写 README-偏差记录.md */
export type u8 = number;
export type u16 = number;

export const CPU_HZ = 4194304; // T 周期/秒
export const DOTS_PER_SCANLINE = 456;
export const SCANLINES_PER_FRAME = 154;
export const SCREEN_W = 160;
export const SCREEN_H = 144;

export interface Bus {
  read(addr: u16): u8;
  write(addr: u16, value: u8): void;
}

export interface CpuState {
  a: u8; f: u8; b: u8; c: u8; d: u8; e: u8; h: u8; l: u8;
  sp: u16; pc: u16;
  ime: boolean;
  halted: boolean;
  /** 复位以来累计 T 周期 */
  totalCycles: number;
}

export interface SM83 {
  reset(): void;
  /** 执行一步（指令或中断服务），返回消耗的 T 周期 */
  step(): number;
  /** 外设请求中断（bit0=VBlank bit1=STAT bit2=Timer bit3=Serial bit4=Joypad） */
  requestInterrupt(bit: u8): void;
  getState(): CpuState;
}

/** 帧缓冲：160×144 RGBA，行优先，长度 160*144*4 = 92160 */
export type Framebuffer = Uint8ClampedArray;

export interface PPU {
  reset(): void;
  /** 前进 1 个 T 周期（dot） */
  cycle(): void;
  /** 总线转发：$8000-$9FFF、$FE00-$FE9F、$FF40-$FF4B 的读写由总线原样转到这里 */
  busRead(addr: u16): u8;
  busWrite(addr: u16, value: u8): void;
  /** OAM DMA：总线在 $FF46 写入时调用，用 readFn 把源 160 字节搬进 OAM */
  oamDma(start: u16, readFn: (addr: u16) => u8): void;
  /** 最近一帧帧缓冲（内部复用同一 buffer，需留存请自行拷贝） */
  getFramebuffer(): Framebuffer;
}
