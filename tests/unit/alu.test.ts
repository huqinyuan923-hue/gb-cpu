import { describe, expect, it } from 'vitest';
import { runN } from '../helpers/runOne';
import { flags } from '../helpers/fakeBus';

/**
 * ALU A,r 边界矩阵：ADD/ADC/SUB/SBC/AND/XOR/OR/CP
 * 操作数取边界象限：00 / 0F / 80 / FF（半进位、进位、全 0、全 1）
 */

const VALS = [0x00, 0x0F, 0x80, 0xFF] as const;

// —— 期望值（测试内独立实现，与 src/cpu/alu.ts 互为对照）——
function expAdd(a: number, b: number, c: number): { v: number; z: boolean; h: boolean; c: boolean } {
  const s = a + b + c;
  return {
    v: s & 0xFF,
    z: (s & 0xFF) === 0,
    h: ((a & 0xF) + (b & 0xF) + c) >>> 4 === 1,
    c: s >>> 8 === 1,
  };
}
function expSub(a: number, b: number, c: number): { v: number; z: boolean; h: boolean; c: boolean } {
  const d = a - b - c;
  return {
    v: d & 0xFF,
    z: (d & 0xFF) === 0,
    h: (a & 0xF) - (b & 0xF) - c < 0,
    c: d < 0,
  };
}
function expAnd(a: number, b: number) { const v = a & b; return { v, z: v === 0, h: true, c: false }; }
function expXor(a: number, b: number) { const v = a ^ b; return { v, z: v === 0, h: false, c: false }; }
function expOr(a: number, b: number) { const v = a | b; return { v, z: v === 0, h: false, c: false }; }

const OPS = [
  { op: 0x80, name: 'ADD A,B', imm: 0xC6, run: (a: number, b: number, c: number) => expAdd(a, b, c) },
  { op: 0x88, name: 'ADC A,B', imm: 0xCE, run: (a: number, b: number, c: number) => expAdd(a, b, c) },
  { op: 0x90, name: 'SUB B', imm: 0xD6, run: (a: number, b: number, c: number) => expSub(a, b, c) },
  { op: 0x98, name: 'SBC A,B', imm: 0xDE, run: (a: number, b: number, c: number) => expSub(a, b, c) },
  { op: 0xA0, name: 'AND B', imm: 0xE6, run: (a: number, b: number) => expAnd(a, b) },
  { op: 0xA8, name: 'XOR B', imm: 0xEE, run: (a: number, b: number) => expXor(a, b) },
  { op: 0xB0, name: 'OR B', imm: 0xF6, run: (a: number, b: number) => expOr(a, b) },
  { op: 0xB8, name: 'CP B', imm: 0xFE, run: (a: number, b: number, c: number) => expSub(a, b, c) },
] as const;

describe('M2 ALU 边界矩阵：寄存器形式（LD B,b; LD A,a; op B）', () => {
  for (const { op, name, run } of OPS) {
    for (const a of VALS) {
      for (const b of VALS) {
        for (const carry of [0, 1]) {
          const isAdcSbc = op === 0x88 || op === 0x98;
          if (!isAdcSbc && carry === 1) continue; // 无进位输入的运算只跑 C=0
          const e = run(a, b, carry);
          const bytes = carry && isAdcSbc
            ? [0x37, 0x06, b, 0x3E, a, op] // SCF 后 ADC/SBC
            : [0x06, b, 0x3E, a, op];
          it(`${name} A=${a.toString(16).padStart(2, '0')} B=${b.toString(16).padStart(2, '0')} C进位=${carry}`, () => {
            const r = runN(bytes, carry && isAdcSbc ? 4 : 3, { sp: 0xFFE0 });
            if (op === 0xB8) {
              expect(r.state.a).toBe(a); // CP 不写回
            } else {
              expect(r.state.a).toBe(e.v);
            }
            expect(flags.z(r.state.f)).toBe(e.z);
            expect(flags.h(r.state.f)).toBe(e.h);
            expect(flags.c(r.state.f)).toBe(e.c);
            expect(r.state.totalCycles % 4).toBe(0);
          });
        }
      }
    }
  }
});

describe('M2 ALU：立即数与 (HL) 形式的标志一致性', () => {
  it('立即数形式 ADD 与寄存器形式结果一致（抽样边界）', () => {
    for (const a of VALS) {
      for (const b of VALS) {
        const e = expAdd(a, b, 0);
        const r = runN([0x3E, a, 0xC6, b], 2); // LD A,a; ADD A,b
        expect(r.state.a).toBe(e.v);
        expect(flags.h(r.state.f)).toBe(e.h);
        expect(flags.c(r.state.f)).toBe(e.c);
      }
    }
  });

  it('(HL) 形式 ADD 与寄存器形式结果一致（抽样边界）', () => {
    for (const a of VALS) {
      for (const b of VALS) {
        const e = expAdd(a, b, 0);
        const r = runN([0x21, 0x50, 0xC0, 0x3E, a, 0x86], 3, {}, 0x0100, (bus) => {
          bus.mem[0xC050] = b;
        });
        expect(r.state.a).toBe(e.v);
        expect(r.cycles).toBe(12 + 8 + 8); // LD HL,nn + LD A,n + ADD A,(HL)
        expect(flags.h(r.state.f)).toBe(e.h);
      }
    }
  });

  it('CP 不写回 A', () => {
    const r = runN([0x3E, 0x7F, 0xFE, 0xFF], 2); // LD A,$7F; CP $FF
    expect(r.state.a).toBe(0x7F);
    expect(flags.c(r.state.f)).toBe(true); // 0x7F < 0xFF → 借位
    expect(flags.n(r.state.f)).toBe(true);
  });

  it('半进位边界：0x0F+0x01 → H=1；0xFF+0x01 → C=1', () => {
    const h = runN([0x3E, 0x0F, 0xC6, 0x01], 2);
    expect(flags.h(h.state.f)).toBe(true);
    expect(flags.c(h.state.f)).toBe(false);
    const c = runN([0x3E, 0xFF, 0xC6, 0x01], 2);
    expect(flags.c(c.state.f)).toBe(true);
    expect(flags.h(c.state.f)).toBe(true);
  });

  it('SUB 借位边界：0x00-0x01 → C=1、H=1；0x12-0x01 → 无借位', () => {
    const s1 = runN([0x3E, 0x00, 0xD6, 0x01], 2);
    expect(flags.c(s1.state.f)).toBe(true);
    expect(flags.h(s1.state.f)).toBe(true);
    const s2 = runN([0x3E, 0x12, 0xD6, 0x01], 2);
    expect(flags.c(s2.state.f)).toBe(false);
    expect(flags.h(s2.state.f)).toBe(false);
  });

  it('XOR A 自清零且 Z=1（boot ROM 惯用法）', () => {
    const r = runN([0x3E, 0x55, 0xAF], 2); // LD A,$55; XOR A
    expect(r.state.a).toBe(0x00);
    expect(r.state.f).toBe(0x80);
  });
});

describe('M2 INC/DEC r：C 保持与半进位边界', () => {
  const REGS = [
    { set: [0x06] as const, inc: 0x04, dec: 0x05, name: 'B' },
    { set: [0x0E] as const, inc: 0x0C, dec: 0x0D, name: 'C' },
    { set: [0x26] as const, inc: 0x24, dec: 0x25, name: 'H' },
    { set: [0x3E] as const, inc: 0x3C, dec: 0x3D, name: 'A' },
  ];

  for (const r of REGS) {
    it(`INC ${r.name}: 0x0F → 0x10, H=1, C 保持`, () => {
      const res = runN([...r.set, 0x0F, r.inc], 2, { f: 0x10 });
      expect(res.state.f).toBe(0x30); // C 保持 + H=1（Z=0，N=0）
    });
    it(`DEC ${r.name}: 0x00 → 0xFF, H=1, C 保持`, () => {
      const res = runN([...r.set, 0x00, r.dec], 2, { f: 0x10 });
      expect(res.state.f).toBe(0x70); // C 保持 + N=1 + H=1
    });
    it(`INC ${r.name}: 0xFF → 0x00, Z=1`, () => {
      const res = runN([...r.set, 0xFF, r.inc], 2);
      expect(res.state.f).toBe(0xA0); // Z=1 + H=1
    });
  }
});
