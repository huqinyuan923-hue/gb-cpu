import { describe, expect, it } from 'vitest';
import { runN } from '../helpers/runOne';
import { flags } from '../helpers/fakeBus';

/**
 * DAA 四象限专项：
 * 1. 手工四象限金向量；
 * 2. BCD 性质对拍——随机 BCD 加/减后 DAA 的结果必须等于十进制算术的正确 BCD 结果。
 */

describe('M2 DAA：手工四象限金向量', () => {
  const cases: Array<{
    name: string;
    a: number; f: number; // DAA 之前的 A 与 F
    expA: number; expZ: boolean; expN: boolean; expH: boolean; expC: boolean;
  }> = [
    // N=0（加法后）：低半 >9 → +06；高 >99 → +60
    { name: '加 0x45+0x38=0x7D → H0C0 → BCD 83', a: 0x7D, f: 0x00, expA: 0x83, expZ: false, expN: false, expH: false, expC: false },
    { name: '加 0x37+0x36=0x6D → H=1 → BCD 73', a: 0x6D, f: 0x20, expA: 0x73, expZ: false, expN: false, expH: false, expC: false },
    { name: '加 0x99+0x01=0x9A → 双修正 → 0x00 进位', a: 0x9A, f: 0x00, expA: 0x00, expZ: true, expN: false, expH: false, expC: true },
    { name: '加 0x80+0x90=0x10 → C=1 → BCD 70', a: 0x10, f: 0x10, expA: 0x70, expZ: false, expN: false, expH: false, expC: true },
    { name: '加 0x45+0x38 无需调整', a: 0x45, f: 0x00, expA: 0x45, expZ: false, expN: false, expH: false, expC: false },
    { name: '加 0x42 → H=1 修正 → 0x48', a: 0x42, f: 0x20, expA: 0x48, expZ: false, expN: false, expH: false, expC: false },
    // N=1（减法后）：H → -06；C → -60
    { name: '减 0x45-0x31=0x14 → 无调整 → 0x14', a: 0x14, f: 0x40, expA: 0x14, expZ: false, expN: true, expH: false, expC: false },
    { name: '减 0x45-0x38=0x0D → H=1 → 0x07', a: 0x0D, f: 0x60, expA: 0x07, expZ: false, expN: true, expH: false, expC: false },
    { name: '减 0x51-0x19=0x38 → H=1 → 0x32', a: 0x38, f: 0x60, expA: 0x32, expZ: false, expN: true, expH: false, expC: false },
    { name: '减 0x10-0x70=0xA0 → C=1 → 0x40', a: 0xA0, f: 0x50, expA: 0x40, expZ: false, expN: true, expH: false, expC: true },
    { name: '减 0x30-0x01=0x2F → H=1 → 0x29', a: 0x2F, f: 0x60, expA: 0x29, expZ: false, expN: true, expH: false, expC: false },
    { name: '减 0x40-0x40=0x00 → Z=1', a: 0x00, f: 0xC0, expA: 0x00, expZ: true, expN: true, expH: false, expC: false },
    { name: '减 0x00-0x01=0xFF → C=1 H=1 → 0x99', a: 0xFF, f: 0x70, expA: 0x99, expZ: false, expN: true, expH: false, expC: true },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const r = runN([0x27], 1, { a: c.a, f: c.f }); // DAA
      expect(r.state.a).toBe(c.expA);
      expect(flags.z(r.state.f)).toBe(c.expZ);
      expect(flags.n(r.state.f)).toBe(c.expN);
      expect(flags.h(r.state.f)).toBe(c.expH);
      expect(flags.c(r.state.f)).toBe(c.expC);
    });
  }
});

describe('M2 DAA：BCD 性质对拍（十进制真值为裁判）', () => {
  /** 两位 BCD 合法性：高低半字节各 ≤ 9 */
  const isBcd = (v: number): boolean => (v & 0xF) <= 9 && (v >> 4) <= 9;

  it('加法侧：随机 BCD 对 ADD+DAA == 十进制结果（mod 100）', () => {
    let seed = 0x1234567;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    for (let i = 0; i < 200; i++) {
      // 生成合法 BCD 操作数
      let b1 = 0, b2 = 0;
      do {
        b1 = next() & 0xFF;
      } while (!isBcd(b1));
      do {
        b2 = next() & 0xFF;
      } while (!isBcd(b2));
      const decSum = (b1 >> 4) * 10 + (b1 & 0xF) + (b2 >> 4) * 10 + (b2 & 0xF);
      const expCarry = decSum > 99;
      const expVal = ((decSum % 100) >> 0);
      const expBcd = (Math.floor(expVal / 10) << 4) | (expVal % 10);
      const r = runN([0x3E, b1, 0xC6, b2, 0x27], 3); // LD A; ADD B; DAA
      expect(r.state.a).toBe(expBcd);
      expect(flags.c(r.state.f)).toBe(expCarry);
      expect(flags.n(r.state.f)).toBe(false);
      expect(flags.h(r.state.f)).toBe(false);
    }
  });

  it('减法侧：随机 BCD 对 SUB+DAA == 十进制结果（mod 100）', () => {
    let seed = 0x7654321;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    for (let i = 0; i < 200; i++) {
      let b1 = 0, b2 = 0;
      do {
        b1 = next() & 0xFF;
      } while (!isBcd(b1));
      do {
        b2 = next() & 0xFF;
      } while (!isBcd(b2));
      const d1 = (b1 >> 4) * 10 + (b1 & 0xF);
      const d2 = (b2 >> 4) * 10 + (b2 & 0xF);
      const expCarry = d1 < d2; // 借位
      const diff = (d1 - d2 + 100) % 100;
      const expBcd = (Math.floor(diff / 10) << 4) | (diff % 10);
      const r = runN([0x3E, b1, 0xD6, b2, 0x27], 3); // LD A; SUB B; DAA
      expect(r.state.a).toBe(expBcd);
      expect(flags.c(r.state.f)).toBe(expCarry);
      expect(flags.n(r.state.f)).toBe(true);
      expect(flags.h(r.state.f)).toBe(false);
    }
  });
});
