import { describe, expect, it } from 'vitest';
import { runN, runOne } from '../helpers/runOne';
import { flags } from '../helpers/fakeBus';

/**
 * CB 页语义专项：8 种移位/循环 × 边界值、BIT/RES/SET、(HL) 形式的读写副作用。
 */

const VALS = [0x00, 0x01, 0x0F, 0x80, 0xFF, 0x55, 0xAA] as const;

// —— 独立期望实现 ——
function expRlc(v: number): { v: number; z: boolean; c: boolean } {
  const c = (v >> 7) & 1;
  return { v: ((v << 1) | c) & 0xFF, z: (((v << 1) | c) & 0xFF) === 0, c: c === 1 };
}
function expRrc(v: number): { v: number; z: boolean; c: boolean } {
  const c = v & 1;
  return { v: ((v >> 1) | (c << 7)) & 0xFF, z: ((v >> 1) | (c << 7)) === 0, c: c === 1 };
}
function expRl(v: number, ci: number): { v: number; z: boolean; c: boolean } {
  const c = (v >> 7) & 1;
  const r = ((v << 1) | ci) & 0xFF;
  return { v: r, z: r === 0, c: c === 1 };
}
function expRr(v: number, ci: number): { v: number; z: boolean; c: boolean } {
  const c = v & 1;
  const r = (v >> 1) | (ci << 7);
  return { v: r & 0xFF, z: r === 0, c: c === 1 };
}
function expSla(v: number): { v: number; z: boolean; c: boolean } {
  const r = (v << 1) & 0xFF;
  return { v: r, z: r === 0, c: (v >> 7 & 1) === 1 };
}
function expSra(v: number): { v: number; z: boolean; c: boolean } {
  const r = (v >> 1) | (v & 0x80);
  return { v: r & 0xFF, z: r === 0, c: (v & 1) === 1 };
}
function expSwap(v: number): { v: number; z: boolean } {
  const r = ((v << 4) | (v >> 4)) & 0xFF;
  return { v: r, z: r === 0 };
}
function expSrl(v: number): { v: number; z: boolean; c: boolean } {
  const r = v >> 1;
  return { v: r & 0xFF, z: r === 0, c: (v & 1) === 1 };
}

const ROT = [
  { cb: 0x00, name: 'RLC', run: expRlc },
  { cb: 0x08, name: 'RRC', run: expRrc },
  { cb: 0x20, name: 'SLA', run: expSla },
  { cb: 0x28, name: 'SRA', run: expSra },
  { cb: 0x30, name: 'SWAP', run: expSwap },
  { cb: 0x38, name: 'SRL', run: expSrl },
] as const;

describe('M2 CB 页：RLC/RRC/SLA/SRA/SWAP/SRL on B（边界值矩阵）', () => {
  for (const { cb, name, run } of ROT) {
    for (const v of VALS) {
      it(`${name} B, 0x${v.toString(16).padStart(2, '0')}`, () => {
        const e = run(v);
        const r = runN([0x06, v, 0xCB, cb], 2); // LD B,v; CB xx B
        expect(r.state.b).toBe(e.v);
        expect(flags.z(r.state.f)).toBe(e.z);
        expect(flags.n(r.state.f)).toBe(false);
        expect(flags.h(r.state.f)).toBe(false);
        if ('c' in e) expect(flags.c(r.state.f)).toBe(e.c);
        else expect(flags.c(r.state.f)).toBe(false); // SWAP：C 清零
        expect(r.cycles).toBe(8 + 8); // LD B,n(8) + CB 寄存器形式(8)
      });
    }
  }
});

describe('M2 CB 页：RL/RR 带进位输入', () => {
  for (const v of VALS) {
    for (const ci of [0, 1]) {
      it(`RL B 0x${v.toString(16).padStart(2, '0')} C进位=${ci}`, () => {
        const e = expRl(v, ci);
        const bytes = ci ? [0x06, v, 0x37, 0xCB, 0x10] : [0x06, v, 0xCB, 0x10];
        const r = runN(bytes, ci ? 3 : 2); // (SCF;) LD B; RL B
        expect(r.state.b).toBe(e.v);
        expect(flags.c(r.state.f)).toBe(e.c);
        expect(flags.z(r.state.f)).toBe(e.z);
      });
      it(`RR B 0x${v.toString(16).padStart(2, '0')} C进位=${ci}`, () => {
        const e = expRr(v, ci);
        const bytes = ci ? [0x06, v, 0x37, 0xCB, 0x18] : [0x06, v, 0xCB, 0x18];
        const r = runN(bytes, ci ? 3 : 2);
        expect(r.state.b).toBe(e.v);
        expect(flags.c(r.state.f)).toBe(e.c);
      });
    }
  }
});

describe('M2 CB 页：A 寄存器全操作（LD A; CB xx A）', () => {
  it('RLC A / SWAP A / SRL A 抽样', () => {
    const r1 = runN([0x3E, 0x81, 0xCB, 0x07], 2); // RLC A
    expect(r1.state.a).toBe(0x03);
    expect(flags.c(r1.state.f)).toBe(true);
    const r2 = runN([0x3E, 0x1E, 0xCB, 0x37], 2); // SWAP A
    expect(r2.state.a).toBe(0xE1);
    const r3 = runN([0x3E, 0xF0, 0xCB, 0x3F], 2); // SRL A
    expect(r3.state.a).toBe(0x78);
    expect(flags.c(r3.state.f)).toBe(false);
    expect(flags.z(r3.state.f)).toBe(false);
  });
});

describe('M2 CB 页：BIT/RES/SET', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('BIT %d,B：0xFF 全部为 1（Z=0，H=1，C 保持）', (n) => {
    const r = runN([0x06, 0xFF, 0xCB, 0x40 + n * 8], 2, { f: 0x10 });
    expect(flags.z(r.state.f)).toBe(false);
    expect(flags.h(r.state.f)).toBe(true);
    expect(flags.c(r.state.f)).toBe(true); // C 保持
    expect(flags.n(r.state.f)).toBe(false);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('BIT %d,B：0x00 全部为 0（Z=1）', (n) => {
    const r = runN([0x06, 0x00, 0xCB, 0x40 + n * 8], 2);
    expect(flags.z(r.state.f)).toBe(true);
  });

  it('BIT 单位检测：0x20 只有 bit5 为 1', () => {
    const r = runN([0x06, 0x20, 0xCB, 0x68], 2); // BIT 5,B
    expect(flags.z(r.state.f)).toBe(false);
    const r2 = runN([0x06, 0x20, 0xCB, 0x60], 2); // BIT 0,B
    expect(flags.z(r2.state.f)).toBe(true);
  });

  it('RES/SET 各位（B 与 A 抽样）', () => {
    const r = runN([0x06, 0xFF, 0xCB, 0x80], 2); // RES 0,B
    expect(r.state.b).toBe(0xFE);
    const r2 = runN([0x06, 0x00, 0xCB, 0xC0], 2); // SET 0,B
    expect(r2.state.b).toBe(0x01);
    const r3 = runN([0x3E, 0x00, 0xCB, 0xFF], 2); // SET 7,A
    expect(r3.state.a).toBe(0x80);
    // RES/SET 不动标志
    const r4 = runN([0x06, 0x00, 0xCB, 0xC0], 2, { f: 0xF0 }); // SET 0,B
    expect(r4.state.f).toBe(0xF0);
  });
});

describe('M2 CB 页：(HL) 形式的读改写与周期', () => {
  const HL = 0xC050;

  function runHL(sub: number, memVal: number, f = 0x00) {
    return runN([0x21, HL & 0xFF, HL >> 8, 0xCB, sub], 2, { f }, 0x0100, (bus) => {
      bus.mem[HL] = memVal;
    });
  }

  it('RLC (HL)：读改写内存，16T', () => {
    const e = expRlc(0x81);
    const r = runHL(0x06, 0x81);
    expect(r.bus.mem[HL]).toBe(e.v);
    expect(r.cycles).toBe(12 + 16); // LD HL,nn(12) + RLC (HL)(16)
    expect(flags.c(r.state.f)).toBe(e.c);
  });

  it('BIT 5,(HL)：只读不写，12T', () => {
    const r = runHL(0x6E, 0x20);
    expect(r.bus.mem[HL]).toBe(0x20); // 未修改
    expect(r.cycles).toBe(12 + 12);
    expect(flags.z(r.state.f)).toBe(false);
    expect(flags.h(r.state.f)).toBe(true);
  });

  it('RES 2,(HL) / SET 0,(HL)', () => {
    const r1 = runHL(0x96, 0xFF); // RES 2,(HL)（0x96 = x2 y2 z6）
    expect(r1.bus.mem[HL]).toBe(0xFF & ~0x04);
    expect(r1.cycles).toBe(12 + 16);
    const r2 = runHL(0xC6, 0x00); // SET 0,(HL)
    expect(r2.bus.mem[HL]).toBe(0x01);
  });

  it('SWAP (HL)：0x00 → Z=1', () => {
    const r = runHL(0x36, 0x00); // SWAP (HL)
    expect(r.bus.mem[HL]).toBe(0x00);
    expect(flags.z(r.state.f)).toBe(true);
  });

  it('单条 runOne 的 CB (HL) 周期 = 16T', () => {
    const r = runOne([0xCB, 0x06], { h: (HL >> 8) & 0xFF, l: HL & 0xFF }, 0x0100, (bus) => {
      bus.mem[HL] = 0x7F;
    });
    expect(r.cycles).toBe(16);
    expect(r.bus.mem[HL]).toBe(0xFE); // RLC 0x7F = 0xFE
  });
});
