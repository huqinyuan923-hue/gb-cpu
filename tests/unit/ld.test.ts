import { describe, expect, it } from 'vitest';
import { runN, BASE } from '../helpers/runOne';
import { reg16 } from '../helpers/fakeBus';

/**
 * LD 寻址专项：(HL±) 步进与回绕、(BC)/(DE)、(C) IO 区、LD (nn),SP 写序、
 * 跨页地址、PC 回绕取指。
 */

describe('M2 LD：(HL+)/(HL-) 步进', () => {
  it('LD (HL+),A 连续写 4 字节后 HL 步进 4', () => {
    const bytes = [0x21, 0x10, 0xC0, 0x3E, 0x11, 0x22, 0x22, 0x22, 0x22];
    const r = runN(bytes, 6);
    expect(r.bus.mem[0xC010]).toBe(0x11);
    expect(r.bus.mem[0xC011]).toBe(0x11);
    expect(r.bus.mem[0xC012]).toBe(0x11);
    expect(r.bus.mem[0xC013]).toBe(0x11);
    expect(r.state.h).toBe(0xC0);
    expect(r.state.l).toBe(0x14);
    expect(r.cycles).toBe(12 + 8 + 8 * 4);
  });

  it('LD (HL-),A 向下步进', () => {
    const r = runN([0x21, 0x10, 0xC0, 0x3E, 0x5A, 0x32, 0x32], 5);
    expect(r.bus.mem[0xC010]).toBe(0x5A);
    expect(r.bus.mem[0xC00F]).toBe(0x5A);
    expect(reg16.hl(r.state)).toBe(0xC00E);
  });

  it('$FFFF 步进回绕到 $0000', () => {
    const r = runN([0x21, 0xFF, 0xFF, 0x3E, 0x77, 0x22, 0x22], 6);
    expect(r.bus.mem[0xFFFF]).toBe(0x77);
    expect(r.bus.mem[0x0000]).toBe(0x77); // 回绕写入
    expect(reg16.hl(r.state)).toBe(0x0001);
  });

  it('LD A,(HL-) 从 $0000 向下回绕到 $FFFF', () => {
    const r = runN([0x21, 0x00, 0x00, 0x3E, 0x99, 0x3A, 0x3A], 5, {}, BASE, (bus) => {
      bus.mem[0xFFFF] = 0x42;
    });
    expect(r.state.a).toBe(0x42);
    expect(reg16.hl(r.state)).toBe(0xFFFE);
  });
});

describe('M2 LD：(BC)/(DE) 间接寻址', () => {
  it('LD A,(BC) / LD (DE),A 往返', () => {
    const bytes = [0x01, 0x00, 0xC0, 0x11, 0x50, 0xC0, 0x3E, 0x66, 0x12, 0x1A];
    const r = runN(bytes, 5, {}, BASE, (bus) => {
      bus.mem[0xC000] = 0x33;
    });
    expect(r.bus.mem[0xC050]).toBe(0x66);
    expect(r.state.a).toBe(0x66);
    expect(r.bus.mem[0xC000]).toBe(0x33); // 未触碰
    expect(r.cycles).toBe(12 + 12 + 8 + 8 + 8);
  });

  it('LD (BC),A：BC 边界 $FFFF 写入回绕', () => {
    const r = runN([0x01, 0xFF, 0xFF, 0x3E, 0x88, 0x02], 3);
    expect(r.bus.mem[0xFFFF]).toBe(0x88);
  });
});

describe('M2 LD：(C) 伪 IO 区 $FF00-$FFFF', () => {
  it('LD (C),A / LD A,(C) 地址 = $FF00|C', () => {
    const r = runN([0x3E, 0x12, 0x0E, 0x80, 0xE2, 0xF2], 4);
    expect(r.bus.mem[0xFF80]).toBe(0x12);
    expect(r.state.a).toBe(0x12);
    expect(r.cycles).toBe(8 + 8 + 8 + 8);
  });

  it('LDH (n),A / LDH A,(n)：$FF00+n', () => {
    const r = runN([0x3E, 0x55, 0xE0, 0x30, 0xF0, 0x30], 3);
    expect(r.bus.mem[0xFF30]).toBe(0x55);
    expect(r.state.a).toBe(0x55);
    expect(r.cycles).toBe(8 + 12 + 12);
  });
});

describe('M2 LD：LD (nn),SP 写序与 20T', () => {
  it('低字节写低地址，高字节写高地址', () => {
    const r = runN([0x31, 0xCD, 0xAB, 0x08, 0x00, 0xD0], 2); // LD SP,$ABCD; LD ($D000),SP
    expect(r.bus.mem[0xD000]).toBe(0xCD);
    expect(r.bus.mem[0xD001]).toBe(0xAB);
    expect(r.cycles).toBe(12 + 20);
  });

  it('nn=$FFFE：高字节写 $FFFF', () => {
    const r = runN([0x31, 0x34, 0x12, 0x08, 0xFE, 0xFF], 2);
    expect(r.bus.mem[0xFFFE]).toBe(0x34);
    expect(r.bus.mem[0xFFFF]).toBe(0x12);
  });
});

describe('M2 LD：LD HL,SP+n / ADD SP,n 带符号运算', () => {
  it('正偏移 +0x7F：无进位路径', () => {
    const r = runN([0x31, 0x00, 0x10, 0xF8, 0x7F], 2); // LD SP,$1000; LD HL,SP+127
    expect(reg16.hl(r.state)).toBe(0x107F);
    expect(r.state.f).toBe(0x00); // Z=N=0，无 H/C
    expect(r.cycles).toBe(12 + 12);
  });

  it('负偏移 -0x80：SP+$FF80 = $0F80', () => {
    const r = runN([0x31, 0x00, 0x10, 0xF8, 0x80], 2);
    expect(reg16.hl(r.state)).toBe(0x0F80);
    expect(r.state.f).toBe(0x00);
  });

  it('H 边界：SP=$000F，+1 → H=1', () => {
    const r = runN([0x31, 0x0F, 0x00, 0xF8, 0x01], 2);
    expect(reg16.hl(r.state)).toBe(0x0010);
    expect(r.state.f).toBe(0x20); // H=1
  });

  it('C 边界：SP=$00FF，+1 → C=1 且 H=1', () => {
    const r = runN([0x31, 0xFF, 0x00, 0xF8, 0x01], 2);
    expect(reg16.hl(r.state)).toBe(0x0100);
    expect(r.state.f).toBe(0x30); // H+C
  });

  it('ADD SP,n：结果写 SP，Z=N=0', () => {
    const r = runN([0x31, 0xFF, 0x00, 0xE8, 0x01], 2); // SP=$00FF; ADD SP,1
    expect(r.state.sp).toBe(0x0100);
    expect(r.state.f).toBe(0x30);
    expect(r.cycles).toBe(12 + 16);
  });

  it('ADD SP,n 负偏移回绕：$0000-1 → $FFFF，无半进位', () => {
    const r = runN([0x31, 0x00, 0x00, 0xE8, 0xFF], 2); // ADD SP,-1
    expect(r.state.sp).toBe(0xFFFF);
    // 低 8 位无符号加：0x00+0xFF=0xFF —— bit3 无进位、bit7 无进位 → H=0 C=0
    expect(r.state.f).toBe(0x00);
  });
});

describe('M2 LD：INC/DEC rr 回绕与无标志', () => {
  it('INC BC：$FFFF → $0000，标志不变', () => {
    const r = runN([0x01, 0xFF, 0xFF, 0x03], 2, { f: 0xB0 });
    expect(r.state.b).toBe(0x00);
    expect(r.state.c).toBe(0x00);
    expect(r.state.f).toBe(0xB0); // 完全不动
    expect(r.cycles).toBe(12 + 8);
  });

  it('DEC HL：$0000 → $FFFF，标志不变', () => {
    const r = runN([0x21, 0x00, 0x00, 0x2B], 2, { f: 0xB0 });
    expect(reg16.hl(r.state)).toBe(0xFFFF);
    expect(r.state.f).toBe(0xB0);
  });

  it('INC SP / DEC SP：8T', () => {
    const r1 = runN([0x31, 0xFE, 0xFF, 0x33], 2);
    expect(r1.state.sp).toBe(0xFFFF);
    expect(r1.cycles).toBe(12 + 8);
    const r2 = runN([0x31, 0x00, 0x00, 0x3B], 2);
    expect(r2.state.sp).toBe(0xFFFF);
  });
});

describe('M2 LD：ADD HL,rr 标志边界', () => {
  it('半进位 bit11：$0FFF + $0001 → H=1', () => {
    const r = runN([0x21, 0xFF, 0x0F, 0x01, 0x01, 0x00, 0x09], 3); // ADD HL,BC
    expect(reg16.hl(r.state)).toBe(0x1000);
    expect(r.state.f).toBe(0x20); // H=1，Z 保持（初始 0）
  });

  it('进位 bit15：$FFFF + $0001 → C=1 H=1', () => {
    const r = runN([0x21, 0xFF, 0xFF, 0x01, 0x01, 0x00, 0x09], 3);
    expect(reg16.hl(r.state)).toBe(0x0000);
    expect(r.state.f).toBe(0x30);
  });

  it('ADD HL,HL：无进位路径', () => {
    const r = runN([0x21, 0x11, 0x11, 0x29], 2);
    expect(reg16.hl(r.state)).toBe(0x2222);
    expect(r.state.f).toBe(0x00);
  });
});
