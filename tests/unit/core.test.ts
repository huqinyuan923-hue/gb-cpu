import { describe, expect, it } from 'vitest';
import { createSM83 } from '../../src/cpu/createCPU';
import { FakeBus, flags } from '../helpers/fakeBus';
import { BASE, le16, runN, runOne } from '../helpers/runOne';
import type { CpuState } from '../../src/contract';

describe('M1 核心：复位与状态', () => {
  it('reset 后寄存器全零、PC=0、IME 关', () => {
    const bus = new FakeBus();
    const cpu = createSM83(bus);
    cpu.reset();
    const s = cpu.getState();
    expect(s).toEqual({
      a: 0, f: 0, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0,
      sp: 0, pc: 0, ime: false, halted: false, totalCycles: 0,
    } satisfies CpuState);
  });

  it('reset 清除运行状态（HALT/锁死/锁存）', () => {
    const bus = new FakeBus();
    const cpu = createSM83(bus);
    bus.setBytes(0, [0xD3]); // 非法 → 锁死
    cpu.reset();
    cpu.step();
    expect(cpu.isLocked()).toBe(true);
    cpu.reset();
    expect(cpu.isLocked()).toBe(false);
    const s = cpu.getState();
    expect(s.halted).toBe(false);
    expect(s.totalCycles).toBe(0);
  });

  it('totalCycles 随 step 累计', () => {
    const bus = new FakeBus();
    const cpu = createSM83(bus);
    cpu.reset();
    bus.setBytes(0, [0x00, 0x00, 0x00]); // NOP×3
    let t = 0;
    for (let i = 0; i < 3; i++) t += cpu.step();
    expect(t).toBe(12);
    expect(cpu.getState().totalCycles).toBe(12);
  });
});

describe('M1 核心：F 寄存器与标志位', () => {
  it('F 只有 bit7-4 有效：POP AF 自动屏蔽低 4 位', () => {
    const { state } = runOne([0xF1], { sp: 0xFFFE }); // POP AF
    expect(state.a).toBe(0x00);
    expect(state.f).toBe(0x00); // 栈顶是 0
  });

  it('POP AF：A/F 分别就位，F 低 4 位被清', () => {
    const r = runOne([0xF1], { sp: 0xFFFE }, BASE, (bus) => {
      bus.mem[0xFFFE] = 0x5A; // F 低位
      bus.mem[0xFFFF] = 0x9C; // A
    }); // POP AF
    expect(r.state.a).toBe(0x9C);
    // 精确断言：f = 0x5A & 0xF0 = 0x50
    expect(r.state.f).toBe(0x50);
  });

  it('SCF/CCF/CPL 的标志组合', () => {
    // SCF：N=H=0，C=1，Z 保持
    const scf = runOne([0x37], { f: 0x80 }).state; // Z=1 起
    expect(scf.f).toBe(0x90); // Z=1, C=1
    const scf2 = runOne([0x37], { f: 0x40 }).state; // N=1 起
    expect(scf2.f).toBe(0x10); // N 清零
    // CCF：C 取反
    const ccf = runOne([0x3F], { f: 0x10 }).state; // C=1 起
    expect(ccf.f).toBe(0x00);
    const ccf2 = runOne([0x3F], { f: 0x00 }).state;
    expect(ccf2.f).toBe(0x10);
    // CPL：N=H=1，A 取反
    const cpl = runOne([0x2F], { a: 0x0F, f: 0x80 }).state;
    expect(cpl.a).toBe(0xF0);
    expect(cpl.f).toBe(0xE0); // Z 保持 + N + H
  });
});

describe('M1 核心：栈与 16 位寄存器对', () => {
  it('PUSH 高字节在低地址（$FFFD=高），SP 减 2', () => {
    const r = runOne([0xC5], { b: 0x12, c: 0x34, sp: 0xFFFE }); // PUSH BC
    expect(r.state.sp).toBe(0xFFFC);
    expect(r.bus.mem[0xFFFD]).toBe(0x12); // 高字节先入栈
    expect(r.bus.mem[0xFFFC]).toBe(0x34);
    expect(r.cycles).toBe(16);
  });

  it('POP 低字节在前，SP 加 2', () => {
    const r = runOne([0xC1], { sp: 0xFFFE }, BASE, (bus) => {
      bus.mem[0xFFFE] = 0x78; // 低
      bus.mem[0xFFFF] = 0x56; // 高
    }); // POP BC
    expect(r.state.b).toBe(0x56);
    expect(r.state.c).toBe(0x78);
    expect(r.state.sp).toBe(0x0000);
    expect(r.cycles).toBe(12);
  });

  it('PUSH/POP AF 往返后 F 低 4 位消失', () => {
    const r = runN([0xF5, 0xF1], 2, { a: 0x33, f: 0xB4, sp: 0xFFFE }); // PUSH AF; POP AF
    expect(r.state.a).toBe(0x33);
    expect(r.state.f).toBe(0xB0); // 0xB4 屏蔽低 4 位
    expect(r.state.sp).toBe(0xFFFE);
  });

  it('SP 回绕：PUSH 到 $0000 以下绕回 $FFFF', () => {
    const { state, bus } = runOne([0xC5], { b: 0x11, c: 0x22, sp: 0x0001 }); // PUSH BC
    expect(state.sp).toBe(0xFFFF);
    expect(bus.mem[0x0000]).toBe(0x11);
    expect(bus.mem[0xFFFF]).toBe(0x22);
  });

  it('SP 回绕：POP 从 $FFFF 读低字节、$0000 读高字节', () => {
    const r = runOne([0xD1], { sp: 0xFFFF }, BASE, (bus) => {
      bus.mem[0xFFFF] = 0xAA; // 低字节（SP 处）
      bus.mem[0x0000] = 0x77; // 高字节（SP+1 回绕）
    }); // POP DE
    expect(r.state.e).toBe(0xAA); // 低字节在 $FFFF
    expect(r.state.d).toBe(0x77); // 高字节回绕到 $0000
    expect(r.state.sp).toBe(0x0001);
  });

  it('16 位寄存器对读写（LD rr,nn / LD SP,HL）', () => {
    const ld = runOne([0x01, ...le16(0xABCD)]); // LD BC,$ABCD
    expect(ld.state.b).toBe(0xAB);
    expect(ld.state.c).toBe(0xCD);
    expect(ld.cycles).toBe(12);
    // LD SP,HL：8T
    const ldsp = runOne([0xF9], { h: 0x11, l: 0x22 });
    expect(ldsp.state.sp).toBe(0x1122);
    expect(ldsp.cycles).toBe(8);
  });
});

describe('M1 核心：周期账本与总线活动', () => {
  it('总线读写在 mem 上可见（LD (nn),A 写序低字节在前地址）', () => {
    const r = runOne([0xEA, 0x34, 0x12], { a: 0x77 }); // LD ($1234),A
    expect(r.bus.mem[0x1234]).toBe(0x77);
    expect(r.cycles).toBe(16);
  });

  it('JP (HL) 跳转：4T 且 PC=HL', () => {
    const r = runOne([0xE9], { h: 0xC0, l: 0x50 });
    expect(r.state.pc).toBe(0xC050);
    expect(r.cycles).toBe(4);
  });

  it('HALT：无挂起中断时进入 HALT，4T', () => {
    const r = runOne([0x76]);
    expect(r.state.halted).toBe(true);
    expect(r.cycles).toBe(4);
    expect(r.state.pc).toBe(BASE + 1);
  });

  it('NOP/DI/EI：4T', () => {
    expect(runOne([0x00]).cycles).toBe(4);
    expect(runOne([0xF3]).cycles).toBe(4);
    expect(runOne([0xFB]).cycles).toBe(4);
    expect(runOne([0xF3]).state.ime).toBe(false);
  });
});

describe('M1 核心：非法 opcode trap', () => {
  // DMG 上 11 个未分配 opcode：执行即锁死
  const ILLEGAL = [0xD3, 0xDB, 0xDD, 0xE3, 0xE4, 0xEB, 0xEC, 0xED, 0xF4, 0xFC, 0xFD];

  it.each(ILLEGAL)('opcode %d 执行即 trap 锁死', (op) => {
    const r = runOne([op]);
    expect(r.cpu.isLocked()).toBe(true);
    expect(r.cycles).toBe(4); // 只有取指
    expect(r.state.pc).toBe(BASE + 1); // 取指完成
  });

  it('锁死后 step 只空转 4T，寄存器冻结', () => {
    const { cpu, bus } = runOne([0xD3], { b: 0x42 });
    bus.setBytes(BASE + 1, [0x3E, 0x99]); // 后续指令不会再执行
    const before = cpu.getState();
    const t1 = cpu.step();
    const after = cpu.getState();
    expect(t1).toBe(4);
    expect(after.b).toBe(0x42);
    expect(after.pc).toBe(before.pc);
    expect(after.totalCycles).toBe(before.totalCycles + 4);
    expect(cpu.isLocked()).toBe(true);
  });

  it('合法 opcode 数量 = 245（256 - 11 非法），CPU 可执行且不锁死', () => {
    let legal = 0;
    for (let op = 0; op <= 0xFF; op++) {
      const bus = new FakeBus();
      const cpu = createSM83(bus);
      cpu.reset();
      // NOP 垫底防止跳转指令吃到随机目标——用手工上下文逐条跑太贵，
      // 这里只验证"不锁死"集合：锁死集合恰为 11 个未分配码
      bus.mem[0] = op;
      cpu.debugSet({ pc: 0 });
      try {
        cpu.step();
      } catch (e) {
        throw new Error(`opcode ${op.toString(16)} 抛异常，派发遗漏`);
      }
      if (!cpu.isLocked()) legal++;
    }
    expect(legal).toBe(245);
  });
});
