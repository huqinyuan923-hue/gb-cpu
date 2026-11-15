import { describe, expect, it } from 'vitest';
import { runN, runOne, BASE } from '../helpers/runOne';
import { flags } from '../helpers/fakeBus';

/**
 * 控制流专项：JR/JP/CALL/RET/RST 的跳转边界、跨页、栈往返、条件时序。
 */

describe('M2 控制流：JR 偏移边界', () => {
  it('JR +0：12T，PC 原地 +2', () => {
    const r = runN([0x18, 0x00, 0x00], 1);
    expect(r.state.pc).toBe(BASE + 2);
    expect(r.cycles).toBe(12);
  });

  it('JR 从 $0104 取指（NOP 铺垫后指令对齐）', () => {
    const r = runN([0x00, 0x00, 0x00, 0x00, 0x18, 0x00], 1, { pc: 0x0104 });
    expect(r.state.pc).toBe(0x0106);
  });

  it('JR 向后跳 -2 覆盖自身形成两字节死循环（取指序列正确）', () => {
    const r = runN([0x18, 0xFE], 1); // JR -2 → 回到本条
    expect(r.state.pc).toBe(BASE); // 回到 JR 自身
    expect(r.cycles).toBe(12);
  });

  it('JR cc：taken 12T / not-taken 8T', () => {
    const taken = runN([0x28, 0x05], 1, { f: 0x80 }); // JR Z
    expect(taken.state.pc).toBe(BASE + 2 + 5);
    expect(taken.cycles).toBe(12);
    const nt = runN([0x28, 0x05], 1, { f: 0x00 });
    expect(nt.state.pc).toBe(BASE + 2);
    expect(nt.cycles).toBe(8);
  });

  it('JR 前向跳到页末回绕：$FFFE + 4 → $0004', () => {
    const r = runN([0x18, 0x04], 1, { pc: 0xFFFE }, 0xFFFE);
    expect(r.state.pc).toBe(0x0004); // PC 回绕
  });
});

describe('M2 控制流：JP 家族', () => {
  it('JP nn：16T，低字节在前', () => {
    const r = runN([0xC3, 0x50, 0x01], 1);
    expect(r.state.pc).toBe(0x0150);
    expect(r.cycles).toBe(16);
  });

  it('JP cc,nn：taken 16T / not-taken 12T', () => {
    const taken = runN([0xCA, 0x50, 0x01], 1, { f: 0x80 });
    expect(taken.state.pc).toBe(0x0150);
    expect(taken.cycles).toBe(16);
    const nt = runN([0xCA, 0x50, 0x01], 1, { f: 0x00 });
    expect(nt.state.pc).toBe(BASE + 3);
    expect(nt.cycles).toBe(12);
  });

  it('JP (HL)：4T，无 PC 自增痕迹', () => {
    const r = runN([0xE9], 1, { h: 0x80, l: 0x00 });
    expect(r.state.pc).toBe(0x8000);
    expect(r.cycles).toBe(4);
  });
});

describe('M2 控制流：CALL/RET/RST 栈往返', () => {
  it('CALL：24T，压入返回地址低字节在前', () => {
    const r = runN([0xCD, 0x50, 0x01], 1, { sp: 0xFFFE });
    expect(r.state.pc).toBe(0x0150);
    expect(r.state.sp).toBe(0xFFFC);
    expect(r.bus.mem[0xFFFD]).toBe(0x01); // 返回地址高字节
    expect(r.bus.mem[0xFFFC]).toBe(0x03); // 低字节（BASE+3）
    expect(r.cycles).toBe(24);
  });

  it('CALL cc：taken 24T / not-taken 12T（不写栈）', () => {
    const nt = runN([0xD4, 0x50, 0x01], 1, { sp: 0xFFFE, f: 0x10 }); // CALL NC：C=1 → 不成立
    expect(nt.state.sp).toBe(0xFFFE);
    expect(nt.state.pc).toBe(BASE + 3);
    expect(nt.cycles).toBe(12);
    const taken = runN([0xD4, 0x50, 0x01], 1, { sp: 0xFFFE, f: 0x00 }); // C=0 → NC 成立
    expect(taken.state.pc).toBe(0x0150);
    expect(taken.cycles).toBe(24);
  });

  it('CALL/RET 完整往返（两层嵌套）', () => {
    // $0100: CALL $0150；$0150: CALL $0160；$0160: RET；$0153: RET → 回 $0103
    const r = runN([0xCD, 0x50, 0x01], 1, { sp: 0xFFE0 });
    r.bus.mem[0x0150] = 0xCD; r.bus.mem[0x0151] = 0x60; r.bus.mem[0x0152] = 0x01; // CALL $0160
    r.bus.mem[0x0160] = 0xC9; // RET
    r.bus.mem[0x0153] = 0xC9; // RET（返回到 $0153 处的收尾）
    const t2 = r.cpu.step(); // 执行 CALL $0160
    const t3 = r.cpu.step(); // RET → 回 $0153
    const t4 = r.cpu.step(); // RET → 回 $0103
    const st = r.cpu.getState();
    expect(st.pc).toBe(0x0103);
    expect(st.sp).toBe(0xFFE0);
    expect(t2).toBe(24);
    expect(t3).toBe(16);
    expect(t4).toBe(16);
  });

  it('RET cc：taken 20T / not-taken 8T', () => {
    const nt = runN([0xC0, 0x00], 1, { sp: 0xFFF0, f: 0x80 }); // RET NZ，Z=1 → 不跳
    expect(nt.cycles).toBe(8);
    const taken = runN([0xC0], 1, { sp: 0xFFF0, f: 0x00 }, BASE, (bus) => {
      bus.mem[0xFFF0] = 0x40;
      bus.mem[0xFFF1] = 0x01;
    });
    expect(taken.state.pc).toBe(0x0140);
    expect(taken.cycles).toBe(20);
  });

  it('RETI：16T + IME 立即置位', () => {
    const r = runN([0xD9], 1, { sp: 0xFFF0, ime: false }, BASE, (bus) => {
      bus.mem[0xFFF0] = 0x40;
      bus.mem[0xFFF1] = 0x01;
    });
    expect(r.state.pc).toBe(0x0140);
    expect(r.state.ime).toBe(true);
    expect(r.cycles).toBe(16);
  });

  it('RST 8 个向量：16T，PC 到 $00-$38', () => {
    for (let t = 0; t < 8; t++) {
      const r = runN([0xC7 + t * 8], 1, { sp: 0xFFE0 });
      expect(r.state.pc).toBe(t * 8);
      expect(r.state.sp).toBe(0xFFDE);
      expect(r.bus.mem[0xFFDF]).toBe(0x01); // 返回地址高字节
      expect(r.bus.mem[0xFFDE]).toBe(0x01); // 返回地址低字节（$0101）
      expect(r.cycles).toBe(16);
    }
  });

  it('栈下溢回绕：SP=$0000 CALL → 写 $FFFF/$FFFE', () => {
    const r = runN([0xCD, 0x50, 0x01], 1, { sp: 0x0000 });
    expect(r.state.sp).toBe(0xFFFE);
    expect(r.bus.mem[0xFFFF]).toBe(0x01);
    expect(r.bus.mem[0xFFFE]).toBe(0x03);
  });
});

describe('M2 控制流：条件码全矩阵（flags 驱动）', () => {
  const COND = [
    { op: 0x20, name: 'JR NZ', takeF: 0x00, skipF: 0x80 },
    { op: 0x28, name: 'JR Z', takeF: 0x80, skipF: 0x00 },
    { op: 0x30, name: 'JR NC', takeF: 0x00, skipF: 0x10 },
    { op: 0x38, name: 'JR C', takeF: 0x10, skipF: 0x00 },
    { op: 0xC0, name: 'RET NZ', takeF: 0x00, skipF: 0x80 },
    { op: 0xC8, name: 'RET Z', takeF: 0x80, skipF: 0x00 },
    { op: 0xD0, name: 'RET NC', takeF: 0x00, skipF: 0x10 },
    { op: 0xD8, name: 'RET C', takeF: 0x10, skipF: 0x00 },
  ];

  for (const c of COND) {
    it(`${c.name}：taken ${c.op < 0x40 ? 12 : 20}T / not-taken 8T`, () => {
      const take = runN([c.op, 0x00], 1, { f: c.takeF, sp: 0xFFF0 }, BASE, (bus) => {
        bus.mem[0xFFF0] = 0x40;
        bus.mem[0xFFF1] = 0x01;
      });
      const skip = runN([c.op, 0x00], 1, { f: c.skipF, sp: 0xFFF0 });
      expect(take.cycles).toBe(c.op < 0x40 ? 12 : 20);
      expect(skip.cycles).toBe(8);
    });
  }
});
