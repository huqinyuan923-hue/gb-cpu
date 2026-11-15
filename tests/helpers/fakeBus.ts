import type { Bus, u8, u16 } from '../../src/contract';

/**
 * 64KB 全 RAM 假总线：单元测试的受控环境。
 * 所有地址可读可写，读写零副作用——CPU 的总线活动一目了然。
 */
export class FakeBus implements Bus {
  readonly mem = new Uint8Array(0x10000);

  read(addr: u16): u8 {
    return this.mem[addr & 0xFFFF] ?? 0;
  }

  write(addr: u16, value: u8): void {
    this.mem[addr & 0xFFFF] = value & 0xFF;
  }

  /** 批量写入字节流 */
  setBytes(addr: u16, bytes: readonly number[]): void {
    bytes.forEach((b, i) => {
      this.mem[(addr + i) & 0xFFFF] = b & 0xFF;
    });
  }
}

/** 标志位提取 */
export const flags = {
  z: (f: u8): boolean => (f & 0x80) !== 0,
  n: (f: u8): boolean => (f & 0x40) !== 0,
  h: (f: u8): boolean => (f & 0x20) !== 0,
  c: (f: u8): boolean => (f & 0x10) !== 0,
};

/** 16 位寄存器对读取（契约里是 h/l 分离字段） */
export const reg16 = {
  bc: (s: { b: number; c: number }): number => ((s.b << 8) | s.c) & 0xFFFF,
  de: (s: { d: number; e: number }): number => ((s.d << 8) | s.e) & 0xFFFF,
  hl: (s: { h: number; l: number }): number => ((s.h << 8) | s.l) & 0xFFFF,
};
