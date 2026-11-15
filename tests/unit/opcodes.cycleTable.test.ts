import { describe, expect, it } from 'vitest';
import { createSM83 } from '../../src/cpu/createCPU';
import { FakeBus } from '../helpers/fakeBus';

/**
 * 全 opcode 枚举对拍：CPU 实测周期 vs 独立预言机表。
 * 预言机按 pandocs 标准周期表独立写成，与 CPU 的"总线活动记账"互为对照——
 * 任何一条指令的 M 周期数或 PC 推进与表不符立刻报警。
 */

const ILLEGAL = new Set([0xD3, 0xDB, 0xDD, 0xE3, 0xE4, 0xEB, 0xEC, 0xED, 0xF4, 0xFC, 0xFD]);

/** 上下文常量 */
const BASE = 0x0100;
const TARGET = 0x0150; // nn 立即数统一指向这里
const RET_ADDR = 0x1234; // RET 家族从栈上弹出
const HL_VAL = 0xBCDE; // (HL) 统一指向这里（可写 RAM）
const IMM16_ADDR = 0x1234; // (nn) 统一指向这里

/** 条件类的两种标志初值 */
function condFlags(op: number): { taken: number; notTaken: number } {
  const c = (op >> 3) & 3;
  switch (c) {
    case 0: return { taken: 0x00, notTaken: 0x80 }; // NZ
    case 1: return { taken: 0x80, notTaken: 0x00 }; // Z
    case 2: return { taken: 0x00, notTaken: 0x10 }; // NC
    default: return { taken: 0x10, notTaken: 0x00 }; // C
  }
}

/** 指令字节（含立即数；nn 统一 $0150，n 统一 $99/$02） */
function instrBytes(op: number): number[] {
  if (op === 0xCB) return [0xCB, 0x00];
  if (op === 0x18 || (op & 0xE7) === 0x20 && op >= 0x20 && op <= 0x3F) return [op, 0x02]; // JR 偏移 +2
  if (op === 0x08 || op === 0xEA || op === 0xFA) return [op, 0x34, 0x12]; // (nn) = $1234
  if (op === 0xC3 || op === 0xCD) return [op, 0x50, 0x01]; // JP/CALL $0150
  if (op === 0xC2 || op === 0xCA || op === 0xD2 || op === 0xDA) return [op, 0x50, 0x01];
  if (op === 0xC4 || op === 0xCC || op === 0xD4 || op === 0xDC) return [op, 0x50, 0x01];
  if ((op & 0x0F) === 0x01 && op <= 0x3F) return [op, 0x50, 0x01]; // LD rr,nn
  if (op === 0xE0 || op === 0xF0) return [op, 0x80]; // LDH (n) → $FF80
  if ((op & 0xC7) === 0x06 && op <= 0x3F && op !== 0x36) return [op, 0x99]; // LD r,n
  if (op === 0x36) return [op, 0x99]; // LD (HL),n
  if (op >= 0xC6 && op <= 0xFE && (op & 7) === 6 && op !== 0xE9) return [op, 0x99]; // ALU A,n
  return [op];
}

/** 周期预言机：base 页 */
function expBaseCycles(op: number, taken: boolean): number {
  if (ILLEGAL.has(op)) return 4; // 取指后锁死
  if (op <= 0x3F) {
    if (op === 0x00) return 4;
    if ((op & 0x0F) === 0x01) return 12; // LD rr,nn
    if (op === 0x02 || op === 0x12 || op === 0x22 || op === 0x32) return 8;
    if ((op & 0x0F) === 0x03) return 8; // INC rr
    if (op === 0x34) return 12; // INC (HL)
    if ((op & 0xC7) === 0x04) return 4; // INC r
    if (op === 0x35) return 12; // DEC (HL)
    if ((op & 0xC7) === 0x05) return 4; // DEC r
    if (op === 0x36) return 12; // LD (HL),n
    if ((op & 0xC7) === 0x06) return 8; // LD r,n
    if (op === 0x07 || op === 0x0F || op === 0x17 || op === 0x1F) return 4;
    if (op === 0x08) return 20; // LD (nn),SP
    if ((op & 0x0F) === 0x09) return 8; // ADD HL,rr
    if (op === 0x0A || op === 0x1A || op === 0x2A || op === 0x3A) return 8;
    if ((op & 0x0F) === 0x0B) return 8; // DEC rr
    if (op === 0x10) return 8; // STOP：取指 + 填充字节取指（偏差记录）
    if (op === 0x18) return 12; // JR
    if (op >= 0x20 && op <= 0x3F && (op & 0xE7) === 0x20) return taken ? 12 : 8;
    if (op === 0x27 || op === 0x2F || op === 0x37 || op === 0x3F) return 4;
    throw new Error(`预言机缺 0x${op.toString(16)}`);
  }
  if (op <= 0x7F) {
    if (op === 0x76) return 4; // HALT
    return (op & 7) === 6 || ((op >> 3) & 7) === 6 ? 8 : 4;
  }
  if (op <= 0xBF) return (op & 7) === 6 ? 8 : 4;
  switch (op) {
    case 0xC0: case 0xC8: case 0xD0: case 0xD8: return taken ? 20 : 8;
    case 0xC1: case 0xD1: case 0xE1: case 0xF1: return 12;
    case 0xC2: case 0xCA: case 0xD2: case 0xDA: return taken ? 16 : 12;
    case 0xC3: return 16;
    case 0xC4: case 0xCC: case 0xD4: case 0xDC: return taken ? 24 : 12;
    case 0xC5: case 0xD5: case 0xE5: case 0xF5: return 16;
    case 0xC6: case 0xCE: case 0xD6: case 0xDE: case 0xE6: case 0xEE: case 0xF6: case 0xFE: return 8;
    case 0xC7: case 0xCF: case 0xD7: case 0xDF: case 0xE7: case 0xEF: case 0xF7: case 0xFF: return 16;
    case 0xC9: return 16;
    case 0xCB: return 8; // 前缀 + 子码取指（子码 0x00 = RLC B 无额外总线）
    case 0xCD: return 24;
    case 0xD9: return 16;
    case 0xE0: case 0xF0: return 12;
    case 0xE2: case 0xF2: return 8;
    case 0xE8: return 16;
    case 0xE9: return 4;
    case 0xEA: case 0xFA: return 16;
    case 0xF3: case 0xFB: return 4;
    case 0xF8: return 12;
    case 0xF9: return 8;
    default: throw new Error(`预言机缺 0x${op.toString(16)}`);
  }
}

/** PC 推进预言机 */
function expPc(op: number, taken: boolean): number {
  if (ILLEGAL.has(op)) return BASE + 1;
  if (op === 0xCB) return BASE + 2;
  if (op <= 0x3F) {
    if (op === 0x10) return BASE + 2; // STOP 越过填充字节
    if ((op & 0x0F) === 0x01) return BASE + 3;
    if (op === 0x08) return BASE + 3;
    if (op === 0x36 || ((op & 0xC7) === 0x06 && op !== 0x36)) return BASE + 2;
    if (op === 0x18) return BASE + 4; // JR +2
    if (op >= 0x20 && op <= 0x3F && (op & 0xE7) === 0x20) return taken ? BASE + 4 : BASE + 2;
    return BASE + 1;
  }
  if (op <= 0x7F) return BASE + 1;
  if (op <= 0xBF) return BASE + 1;
  switch (op) {
    case 0xC2: case 0xCA: case 0xD2: case 0xDA: return taken ? TARGET : BASE + 3;
    case 0xC3: return TARGET;
    case 0xC4: case 0xCC: case 0xD4: case 0xDC: return taken ? TARGET : BASE + 3;
    case 0xCD: return TARGET;
    case 0xC1: case 0xD1: case 0xE1: case 0xF1: return BASE + 1;
    case 0xC5: case 0xD5: case 0xE5: case 0xF5: return BASE + 1;
    case 0xC6: case 0xCE: case 0xD6: case 0xDE: case 0xE6: case 0xEE: case 0xF6: case 0xFE: return BASE + 2;
    case 0xC7: return 0x00; case 0xCF: return 0x08; case 0xD7: return 0x10; case 0xDF: return 0x18;
    case 0xE7: return 0x20; case 0xEF: return 0x28; case 0xF7: return 0x30; case 0xFF: return 0x38;
    case 0xC9: case 0xD9: return RET_ADDR;
    case 0xE0: case 0xF0: return BASE + 2;
    case 0xE2: case 0xF2: return BASE + 1;
    case 0xE8: return BASE + 2;
    case 0xE9: return HL_VAL;
    case 0xEA: case 0xFA: return BASE + 3;
    case 0xF3: case 0xFB: return BASE + 1;
    case 0xF8: return BASE + 2;
    case 0xF9: return BASE + 1;
    case 0xC0: case 0xC8: case 0xD0: case 0xD8: return taken ? RET_ADDR : BASE + 1;
    default: throw new Error(`PC 预言机缺 0x${op.toString(16)}`);
  }
}

interface RunResult {
  cycles: number;
  pc: number;
  locked: boolean;
  halted: boolean;
}

function runBase(op: number, f: number): RunResult {
  const bus = new FakeBus();
  const cpu = createSM83(bus);
  cpu.reset();
  cpu.debugSet({
    pc: BASE, sp: 0xFFF0, a: 0x12, b: 0x34, c: 0x56, d: 0x78, e: 0x9A,
    h: (HL_VAL >> 8) & 0xFF, l: HL_VAL & 0xFF, f,
  });
  bus.mem[0xFFF0] = RET_ADDR & 0xFF;
  bus.mem[0xFFF1] = (RET_ADDR >> 8) & 0xFF;
  bus.setBytes(BASE, instrBytes(op));
  bus.setBytes(TARGET, [0x00]); // 目标区放 NOP
  const cycles = cpu.step();
  return { cycles, pc: cpu.getState().pc, locked: cpu.isLocked(), halted: cpu.getState().halted };
}

const isCond = (op: number): boolean =>
  (op >= 0x20 && op <= 0x38 && (op & 0xE7) === 0x20) ||
  [0xC0, 0xC8, 0xD0, 0xD8, 0xC2, 0xCA, 0xD2, 0xDA, 0xC4, 0xCC, 0xD4, 0xDC].includes(op);

describe('M2 全 opcode 枚举：周期与 PC 对拍（base 页 256 条）', () => {
  for (let op = 0; op <= 0xFF; op++) {
    if (isCond(op)) {
      const { taken, notTaken } = condFlags(op);
      it(`0x${op.toString(16).padStart(2, '0')} 条件成立`, () => {
        const r = runBase(op, taken);
        expect(r.locked).toBe(false);
        expect(r.cycles).toBe(expBaseCycles(op, true));
        expect(r.pc).toBe(expPc(op, true));
        expect(r.cycles % 4).toBe(0);
      });
      it(`0x${op.toString(16).padStart(2, '0')} 条件不成立`, () => {
        const r = runBase(op, notTaken);
        expect(r.locked).toBe(false);
        expect(r.cycles).toBe(expBaseCycles(op, false));
        expect(r.pc).toBe(expPc(op, false));
        expect(r.cycles % 4).toBe(0);
      });
    } else {
      it(`0x${op.toString(16).padStart(2, '0')}`, () => {
        const r = runBase(op, 0x00);
        expect(r.locked).toBe(ILLEGAL.has(op));
        expect(r.cycles).toBe(expBaseCycles(op, false));
        expect(r.pc).toBe(expPc(op, false));
        expect(r.cycles % 4).toBe(0);
      });
    }
  }

  it('HALT 进入停机态', () => {
    expect(runBase(0x76, 0).halted).toBe(true);
  });
  it('非法 opcode 锁死（11 条已在 each 覆盖，此处验证预言机一致性）', () => {
    for (const op of ILLEGAL) {
      const r = runBase(op, 0);
      expect(r.locked).toBe(true);
      expect(r.cycles).toBe(4);
    }
  });
});

describe('M2 全 opcode 枚举：CB 页 256 条', () => {
  for (let sub = 0; sub <= 0xFF; sub++) {
    const x = (sub >> 6) & 3;
    const z = sub & 7;
    const extra = z === 6 ? (x === 1 ? 4 : 8) : 0; // (HL)：BIT 读一次，其余读+写
    const expected = 8 + extra;
    it(`CB 0x${sub.toString(16).padStart(2, '0')}`, () => {
      const bus = new FakeBus();
      const cpu = createSM83(bus);
      cpu.reset();
      cpu.debugSet({
        pc: BASE, sp: 0xFFF0, a: 0x12, b: 0x34, c: 0x56, d: 0x78, e: 0x9A,
        h: (HL_VAL >> 8) & 0xFF, l: HL_VAL & 0xFF, f: 0x10,
      });
      bus.setBytes(BASE, [0xCB, sub]);
      const cycles = cpu.step();
      expect(cpu.isLocked()).toBe(false);
      expect(cycles).toBe(expected);
      expect(cpu.getState().pc).toBe(BASE + 2);
      expect(cycles % 4).toBe(0);
    });
  }
});
