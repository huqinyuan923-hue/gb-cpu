import type { u8, u16 } from '../contract.js';

/**
 * SM83 ALU · 纯函数层
 *
 * 所有标志计算集中在此，输入输出都是普通数值，不碰总线、不碰周期账本。
 * 标志语义（pandocs 为准）：
 *   Z(bit7) 结果为零   N(bit6) 减法=1   H(bit5) 半进位/半借位   C(bit4) 进位/借位
 */

/** 8 位运算结果：值 + 四个标志 */
export interface AluResult8 {
  v: u8;
  z: boolean;
  n: boolean;
  h: boolean;
  c: boolean;
}

/** 16 位 HL 加法结果：值只动 H/C（Z/N 不受影响） */
export interface AluResult16 {
  v: u16;
  h: boolean;
  c: boolean;
}

/** ADD / ADC：a + b + 进位输入 */
export function add8(a: u8, b: u8, carryIn: boolean): AluResult8 {
  const ci = carryIn ? 1 : 0;
  const sum = a + b + ci;
  return {
    v: sum & 0xFF,
    z: (sum & 0xFF) === 0,
    n: false,
    h: (a & 0xF) + (b & 0xF) + ci > 0xF,
    c: sum > 0xFF,
  };
}

/** SUB / SBC / CP：a - b - 借位输入 */
export function sub8(a: u8, b: u8, carryIn: boolean): AluResult8 {
  const ci = carryIn ? 1 : 0;
  const diff = a - b - ci;
  return {
    v: diff & 0xFF,
    z: (diff & 0xFF) === 0,
    n: true,
    h: (a & 0xF) - (b & 0xF) - ci < 0,
    c: diff < 0,
  };
}

/** AND：Z 置位、H=1 */
export function and8(a: u8, b: u8): AluResult8 {
  const v = a & b;
  return { v, z: v === 0, n: false, h: true, c: false };
}

/** XOR：Z 置位 */
export function xor8(a: u8, b: u8): AluResult8 {
  const v = a ^ b;
  return { v, z: v === 0, n: false, h: false, c: false };
}

/** OR：Z 置位 */
export function or8(a: u8, b: u8): AluResult8 {
  const v = a | b;
  return { v, z: v === 0, n: false, h: false, c: false };
}

/** INC r：N=0、H=进位出 bit3；Z 按结果；C 保持不变（由调用方保留） */
export function inc8(v: u8): { v: u8; z: boolean; h: boolean } {
  const r = (v + 1) & 0xFF;
  return { v: r, z: r === 0, h: (v & 0xF) === 0xF };
}

/** DEC r：N=1、H=借位入 bit4；Z 按结果；C 保持不变（由调用方保留） */
export function dec8(v: u8): { v: u8; z: boolean; h: boolean } {
  const r = (v - 1) & 0xFF;
  return { v: r, z: r === 0, h: (v & 0xF) === 0 };
}

/** ADD HL,rr：Z 不受影响，N=0，H=bit11 进位，C=bit15 进位 */
export function add16(hl: u16, rr: u16): AluResult16 {
  const sum = hl + rr;
  return { v: sum & 0xFFFF, h: (hl & 0xFFF) + (rr & 0xFFF) > 0xFFF, c: sum > 0xFFFF };
}

/**
 * ADD SP,n / LD HL,SP+n：n 为带符号 8 位。
 * 硬件行为：把 n 当无符号数与 SP 的低 8 位做带半进位的加法来判断 H/C，
 * 实际结果按带符号 16 位加法写回（Z=N=0）。
 */
export function addSp(sp: u16, n: number): AluResult16 {
  const unsigned = n & 0xFF;
  return {
    v: (sp + n) & 0xFFFF,
    h: (sp & 0xF) + (unsigned & 0xF) > 0xF,
    c: (sp & 0xFF) + (unsigned & 0xFF) > 0xFF,
  };
}

/**
 * DAA：十进制调整累加器。按上一条加/减指令的 N/H/C 四象限修正。
 *   加法侧（N=0）：低半字节 >9 或 H → +0x06；高 >0x99 或 C → +0x60（置 C）
 *   减法侧（N=1）：H → -0x06；C → -0x60（C 保持）
 */
export function daa(a: u8, n: boolean, h: boolean, c: boolean): AluResult8 {
  let adjust = 0;
  let carry = c;
  if (!n) {
    if (h || (a & 0xF) > 0x09) adjust |= 0x06;
    if (c || a > 0x99) {
      adjust |= 0x60;
      carry = true;
    }
  } else {
    if (h) adjust |= 0x06;
    if (c) adjust |= 0x60;
  }
  const v = (n ? a - adjust : a + adjust) & 0xFF;
  return { v, z: v === 0, n, h: false, c: carry };
}

/** CB RLC：循环左移，bit7 → C → bit0 */
export function rlc(v: u8): AluResult8 {
  const c = (v >> 7) === 1;
  const r = ((v << 1) | (c ? 1 : 0)) & 0xFF;
  return { v: r, z: r === 0, n: false, h: false, c };
}

/** CB RRC：循环右移，bit0 → C → bit7 */
export function rrc(v: u8): AluResult8 {
  const c = (v & 1) === 1;
  const r = ((v >> 1) | (c ? 0x80 : 0)) & 0xFF;
  return { v: r, z: r === 0, n: false, h: false, c };
}

/** CB RL：带进位循环左移（bit0 填旧 C） */
export function rl(v: u8, carryIn: boolean): AluResult8 {
  const c = (v >> 7) === 1;
  const r = ((v << 1) | (carryIn ? 1 : 0)) & 0xFF;
  return { v: r, z: r === 0, n: false, h: false, c };
}

/** CB RR：带进位循环右移（bit7 填旧 C） */
export function rr(v: u8, carryIn: boolean): AluResult8 {
  const c = (v & 1) === 1;
  const r = ((v >> 1) | (carryIn ? 0x80 : 0)) & 0xFF;
  return { v: r, z: r === 0, n: false, h: false, c };
}

/** CB SLA：算术左移（bit0 补 0） */
export function sla(v: u8): AluResult8 {
  const c = (v >> 7) === 1;
  const r = (v << 1) & 0xFF;
  return { v: r, z: r === 0, n: false, h: false, c };
}

/** CB SRA：算术右移（符号位保持） */
export function sra(v: u8): AluResult8 {
  const c = (v & 1) === 1;
  const r = ((v >> 1) | (v & 0x80)) & 0xFF;
  return { v: r, z: r === 0, n: false, h: false, c };
}

/** CB SRL：逻辑右移（bit7 补 0） */
export function srl(v: u8): AluResult8 {
  const c = (v & 1) === 1;
  const r = (v >> 1) & 0xFF;
  return { v: r, z: r === 0, n: false, h: false, c };
}

/** CB SWAP：高低半字节交换 */
export function swap(v: u8): AluResult8 {
  const r = ((v << 4) | (v >> 4)) & 0xFF;
  return { v: r, z: r === 0, n: false, h: false, c: false };
}

/** BIT n,r：Z=被测位是否为 0，N=0，H=1，C 保持（由调用方保留） */
export function bit(v: u8, n: number): { z: boolean; h: boolean } {
  return { z: (v & (1 << n)) === 0, h: true };
}

/** CB 页 y=0-7 的八种移位/循环：RLC RRC RL RR SLA SRA SWAP SRL */
export function rotOp(y: number, v: u8, carryIn: boolean): AluResult8 {
  switch (y) {
    case 0: return rlc(v);
    case 1: return rrc(v);
    case 2: return rl(v, carryIn);
    case 3: return rr(v, carryIn);
    case 4: return sla(v);
    case 5: return sra(v);
    case 6: return swap(v);
    default: return srl(v);
  }
}
