import { describe, expect, it } from 'vitest';
import { createSM83 } from '../../src/cpu/createCPU';
import { FakeBus, flags } from '../helpers/fakeBus';
import { BASE, runN, runOne } from '../helpers/runOne';
import type { CpuState } from '../../src/contract';

/**
 * M3 中断系统专项：IE/IF 轮询、20T 服务时序、IME 延迟（EI/DI/RETI）、
 * HALT 进入/唤醒/空转、HALT bug、EI+HALT 交互、优先级与 IF 应答。
 */

function make(bytes: readonly number[], patch: Partial<CpuState> = {}) {
  const bus = new FakeBus();
  const cpu = createSM83(bus);
  cpu.reset();
  bus.setBytes(BASE, bytes);
  cpu.debugSet({ pc: BASE, sp: 0xFFE0, ...patch });
  return { bus, cpu };
}

describe('M3 中断：20T 服务时序与现场', () => {
  it('VBlank 中断：20T，PC=$40，IF bit0 被应答清除', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x01; // IE bit0
    bus.mem[0xFF0F] = 0x01; // IF bit0 挂起
    cpu.debugSet({ ime: true, pc: 0x0300 });
    const t = cpu.step();
    const st = cpu.getState();
    expect(t).toBe(20);
    expect(st.pc).toBe(0x41); // 向量取指已推进 PC
    expect(st.ime).toBe(false);
    expect(st.halted).toBe(false);
    expect(bus.mem[0xFF0F]).toBe(0x00); // 应答清位
    expect(bus.mem[0xFFDF]).toBe(0x03); // 栈：PC 高字节（$0300 → 03）
    expect(bus.mem[0xFFDE]).toBe(0x00); // 栈：PC 低字节
    expect(st.sp).toBe(0xFFDE);
  });

  it('服务序列含向量取指：下一条指令不重复取指（NOP=0T）', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    bus.mem[0x40] = 0x00; // 处理程序第一条：NOP
    cpu.debugSet({ ime: true, pc: 0x0300 });
    expect(cpu.step()).toBe(20); // 服务 + 向量取指（锁存 NOP）
    expect(cpu.getState().pc).toBe(0x41); // 取指已推进
    expect(cpu.step()).toBe(0); // NOP 只剩"执行"，无总线活动 —— 硬件重叠语义
    expect(cpu.getState().pc).toBe(0x41);
  });

  it('多字节处理程序首指令：LD A,n 只剩操作数取指（4T）', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    bus.mem[0x40] = 0x3E; // LD A,n
    bus.mem[0x41] = 0x77;
    cpu.debugSet({ ime: true, pc: 0x0300 });
    expect(cpu.step()).toBe(20);
    expect(cpu.step()).toBe(4); // 仅操作数取指
    const st = cpu.getState();
    expect(st.a).toBe(0x77);
    expect(st.pc).toBe(0x42);
  });

  it('优先级：多源同时挂起时 bit0（VBlank）最优先', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x1F;
    bus.mem[0xFF0F] = 0x1F; // 五源全挂起
    cpu.debugSet({ ime: true, pc: 0x0300 });
    cpu.step();
    expect(cpu.getState().pc).toBe(0x41); // 向量取指已推进 PC（重叠取指语义） // VBlank 向量
    expect(bus.mem[0xFF0F]).toBe(0x1E); // 只清 bit0
  });

  it.each([
    { bit: 1, vector: 0x48, name: 'STAT' },
    { bit: 2, vector: 0x50, name: 'Timer' },
    { bit: 3, vector: 0x58, name: 'Serial' },
    { bit: 4, vector: 0x60, name: 'Joypad' },
  ])('$name 中断（bit$bit）→ 向量 $vector', ({ bit, vector }) => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 1 << bit;
    bus.mem[0xFF0F] = 1 << bit;
    cpu.debugSet({ ime: true, pc: 0x0300 });
    cpu.step();
    expect(cpu.getState().pc).toBe(vector + 1); // 向量取指已推进 PC
  });

  it('requestInterrupt API：置 IF 位（外设入口）', () => {
    const { bus, cpu } = make([0x00]);
    cpu.requestInterrupt(2);
    expect(bus.mem[0xFF0F]).toBe(0x04);
    cpu.requestInterrupt(0);
    expect(bus.mem[0xFF0F]).toBe(0x05);
    cpu.requestInterrupt(9); // 越界：忽略
    expect(bus.mem[0xFF0F]).toBe(0x05);
  });

  it('IE=0：挂起不分发', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x00;
    bus.mem[0xFF0F] = 0x01;
    cpu.debugSet({ ime: true, pc: 0x0300 });
    const t = cpu.step();
    expect(t).toBe(4); // 正常执行 NOP
    expect(cpu.getState().pc).toBe(0x0301);
  });

  it('IME=0：挂起不分发，指令照常执行', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    cpu.debugSet({ ime: false, pc: 0x0300 });
    expect(cpu.step()).toBe(4);
    expect(cpu.getState().pc).toBe(0x0301);
  });
});

describe('M3 中断：IME 延迟（EI/DI/RETI）', () => {
  it('EI 后晚一条指令生效：EI;NOP 时挂起中断在 NOP 后才服务', () => {
    const { bus, cpu } = make([0xFB, 0x00, 0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    const t1 = cpu.step(); // EI：4T，ime 仍 false
    expect(t1).toBe(4);
    expect(cpu.getState().ime).toBe(false);
    const t2 = cpu.step(); // NOP：4T，结束时 ime=true
    expect(t2).toBe(4);
    expect(cpu.getState().ime).toBe(true);
    const t3 = cpu.step(); // 中断服务 20T
    expect(t3).toBe(20);
    expect(cpu.getState().pc).toBe(0x41); // 向量取指已推进 PC（重叠取指语义）
  });

  it('EI;DI：DI 取消悬置，永不分发', () => {
    const { bus, cpu } = make([0xFB, 0xF3, 0x00, 0x00, 0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    cpu.step(); // EI
    cpu.step(); // DI
    expect(cpu.getState().ime).toBe(false);
    for (let i = 0; i < 3; i++) {
      const t = cpu.step();
      expect(t).toBe(4); // 一直是普通 NOP，绝无 20T
    }
    expect(cpu.getState().pc).toBe(BASE + 5);
  });

  it('DI 立即生效（下一条指令就关）', () => {
    const { bus, cpu } = make([0xF3, 0x00]);
    bus.mem[0xFFFF] = 0x01;
    cpu.debugSet({ ime: true, pc: BASE });
    expect(cpu.step()).toBe(4); // DI：ime 置 false
    expect(cpu.getState().ime).toBe(false);
    cpu.requestInterrupt(0); // 现在才挂起
    expect(cpu.step()).toBe(4); // NOP 正常执行，不分发
    expect(cpu.getState().pc).toBe(BASE + 2);
  });

  it('RETI 立即开中断：RETI 后下一步即可分发', () => {
    const { bus, cpu } = make([0xD9, 0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    bus.mem[0xFFF0] = 0x00;
    bus.mem[0xFFF1] = 0x03; // 返回 $0300
    cpu.debugSet({ sp: 0xFFF0, pc: BASE, ime: false });
    expect(cpu.step()).toBe(16); // RETI：ime=true
    expect(cpu.getState().ime).toBe(true);
    expect(cpu.getState().pc).toBe(0x0300);
    expect(cpu.step()).toBe(20); // 返回后立即服务挂起中断
    expect(cpu.getState().pc).toBe(0x41); // 向量取指已推进 PC（重叠取指语义）
  });

  it('EI 延迟期间挂起的中断不会插队', () => {
    // EI 后的下一条指令必须完整执行完（EI;LD A,$42 → A 被写入后才服务）
    const { bus, cpu } = make([0xFB, 0x3E, 0x42, 0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    bus.mem[0x40] = 0x00;
    cpu.step(); // EI：4T
    const t = cpu.step(); // LD A,$42：8T 完整执行
    expect(t).toBe(8);
    expect(cpu.getState().a).toBe(0x42);
    expect(cpu.getState().ime).toBe(true);
    expect(cpu.step()).toBe(20); // 现在才服务
  });
});

describe('M3 中断：HALT 进入 / 唤醒 / 空转', () => {
  it('HALT（IME=1 无挂起）→ 停机，每步空转 4T，totalCycles 累计', () => {
    const { bus, cpu } = make([0x76]);
    bus.mem[0xFFFF] = 0x01; // IE 开但无挂起
    cpu.step();
    expect(cpu.getState().halted).toBe(true);
    const before = cpu.getState().totalCycles;
    const t = cpu.step();
    expect(t).toBe(4);
    expect(cpu.getState().halted).toBe(true);
    expect(cpu.getState().totalCycles).toBe(before + 4);
  });

  it('HALT 唤醒后服务：外设 requestInterrupt → 下一步 20T 分发', () => {
    const { bus, cpu } = make([0x76]);
    bus.mem[0xFFFF] = 0x01;
    cpu.debugSet({ ime: true });
    cpu.step(); // HALT
    cpu.step(); // 空转
    cpu.requestInterrupt(0); // VBlank 到来
    expect(cpu.step()).toBe(20); // 唤醒即服务
    expect(cpu.getState().pc).toBe(0x41); // 向量取指已推进 PC（重叠取指语义）
    expect(cpu.getState().halted).toBe(false);
  });

  it('IME=0 时挂起中断把 CPU 唤醒但不服务', () => {
    const { bus, cpu } = make([0x76, 0x3E, 0x55, 0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x00;
    cpu.debugSet({ ime: false });
    cpu.step(); // HALT：ime=0、无挂起 → 正常停机
    expect(cpu.getState().halted).toBe(true);
    cpu.requestInterrupt(0); // 现在挂起了
    const t = cpu.step(); // 唤醒（4T），不服务
    expect(t).toBe(4);
    const st = cpu.getState();
    expect(st.halted).toBe(false);
    expect(st.pc).toBe(BASE + 1); // 恢复执行 HALT 后的下一条
    const t2 = cpu.step(); // LD A,$55 正常执行（ime=0，不分发）
    expect(t2).toBe(8);
    expect(cpu.getState().a).toBe(0x55);
  });

  it('HALT 唤醒瞬间 IME=1 → 直接服务（无多余唤醒拍）', () => {
    const { bus, cpu } = make([0x76]);
    bus.mem[0xFFFF] = 0x03; // IE 开 VBlank+STAT
    cpu.debugSet({ ime: true });
    cpu.step(); // HALT：4T
    cpu.requestInterrupt(1); // STAT
    expect(cpu.step()).toBe(20);
    expect(cpu.getState().pc).toBe(0x49); // 向量取指已推进 PC
  });

  it('HALT 空转期间 totalCycles 正常累计（1 帧 = 70224T）', () => {
    const { cpu } = make([0x76]);
    cpu.step(); // HALT 4T
    for (let i = 0; i < 17555; i++) cpu.step(); // 17555 × 4T
    expect(cpu.getState().totalCycles).toBe(70224);
  });
});

describe('M3 中断：HALT bug（IME=0 且挂起时 HALT）', () => {
  it('不真停机：下一取指 PC 不递增，opcode 字节被读两次', () => {
    // $0100: HALT; $0101: LD A,$42 —— bug 使 LD A 的 opcode 被读两次 → A=0x3E
    const { bus, cpu } = make([0x76, 0x3E, 0x42, 0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    cpu.debugSet({ ime: false });
    const t1 = cpu.step(); // HALT：4T，bug 锁存，未停机
    expect(t1).toBe(4);
    expect(cpu.getState().halted).toBe(false);
    expect(cpu.getState().pc).toBe(BASE + 1);
    const t2 = cpu.step(); // "LD A,n"：opcode 读两次 → A=0x3E
    expect(t2).toBe(8);
    const st = cpu.getState();
    expect(st.a).toBe(0x3E); // opcode 字节 $3E 被当成操作数
    expect(st.pc).toBe(BASE + 2); // PC 只前进了操作数取指这一步
    // 尾巴：$0102 的 0x42 下一步会被当 opcode 取走（错位执行的连锁效应）
    const t3 = cpu.step(); // fetch $42 = LD B,D（寄存器间传送）
    expect(t3).toBe(4);
  });

  it('bug 触发后 PC 序列：字节重读导致指令"错位"执行', () => {
    // $0100: HALT; $0101: NOP; $0102: LD B,$33 —— bug 后 NOP 先后当 opcode 读两次
    const { bus, cpu } = make([0x76, 0x00, 0x06, 0x33]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    cpu.debugSet({ ime: false });
    cpu.step(); // HALT：bug 锁存，PC=$0101
    expect(cpu.step()).toBe(4); // bug 取指：读 $0101 的 NOP（PC 不动），执行
    expect(cpu.getState().pc).toBe(BASE + 1);
    expect(cpu.step()).toBe(4); // 再次取指 $0101：NOP 第二次执行（PC 这回正常 +1）
    expect(cpu.getState().pc).toBe(BASE + 2);
    cpu.step(); // LD B,$33 正常
    expect(cpu.getState().b).toBe(0x33);
    expect(cpu.getState().pc).toBe(BASE + 4);
  });

  it('EI+HALT+挂起：不触发 bug，正常停机后立即服务', () => {
    const { bus, cpu } = make([0xFB, 0x76]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    bus.mem[0x40] = 0x00;
    cpu.debugSet({ ime: false });
    expect(cpu.step()).toBe(4); // EI：4T
    expect(cpu.step()).toBe(4); // HALT：eiDelay>0 → 正常停机（非 bug），结束时 ime=true
    expect(cpu.getState().halted).toBe(true);
    expect(cpu.step()).toBe(20); // 唤醒即服务
    expect(cpu.getState().pc).toBe(0x41); // 向量取指已推进 PC（重叠取指语义）
  });

  it('EI 后 HALT（无挂起）：正常停机，中断稍后照常服务', () => {
    const { bus, cpu } = make([0xFB, 0x76]);
    bus.mem[0xFFFF] = 0x08; // IE 开串口位
    bus.mem[0x40] = 0x00;
    cpu.debugSet({ ime: false });
    cpu.step(); // EI
    cpu.step(); // HALT：eiDelay 生效 → ime=true，停机
    expect(cpu.getState().halted).toBe(true);
    expect(cpu.getState().ime).toBe(true);
    cpu.requestInterrupt(3); // 串口中断到来
    expect(cpu.step()).toBe(20);
    expect(cpu.getState().pc).toBe(0x59); // 向量取指已推进 PC
  });

  it('挂起瞬间 IF 被 ROM 清零：HALT 不误醒（无 bug 路径）', () => {
    // IME=1 停机中，外设置 IF 又被清 → 继续停机
    const { bus, cpu } = make([0x76]);
    bus.mem[0xFFFF] = 0x01;
    cpu.debugSet({ ime: true });
    cpu.step(); // HALT
    cpu.requestInterrupt(0);
    bus.mem[0xFF0F] = 0x00; // 外部清 IF
    expect(cpu.step()).toBe(4); // 继续空转
    expect(cpu.getState().halted).toBe(true);
  });
});

describe('M3 中断：应答与栈细节', () => {
  it('栈中保存的返回地址 = 中断前的 PC', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x02;
    bus.mem[0xFF0F] = 0x02;
    cpu.debugSet({ ime: true, pc: 0x1234, sp: 0xC100 });
    cpu.step();
    expect(bus.mem[0xC0FF]).toBe(0x12); // 高字节在低地址（SP-1）
    expect(bus.mem[0xC0FE]).toBe(0x34); // 低字节（SP-2）
    expect(cpu.getState().sp).toBe(0xC0FE);
  });

  it('连续服务：RETI 开中断后再次分发剩余挂起源', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x03; // IE bit0|bit1
    bus.mem[0xFF0F] = 0x03; // 两源挂起
    bus.mem[0x40] = 0xD9; // VBlank handler 首条：RETI
    bus.mem[0xFFDE] = 0x34; // 栈上"返回地址" $1234（低）
    bus.mem[0xFFDF] = 0x12; // 高
    cpu.debugSet({ ime: true, pc: 0x1234, sp: 0xFFE0 });
    expect(cpu.step()).toBe(20); // VBlank 服务
    expect(cpu.getState().pc).toBe(0x41); // 向量取指已推进 PC（重叠取指语义）
    expect(cpu.step()).toBe(12); // RETI（锁存取指，剩 12T）：ime=true，回 $1234
    expect(cpu.getState().ime).toBe(true);
    expect(cpu.step()).toBe(20); // 立即服务 STAT
    expect(cpu.getState().pc).toBe(0x49); // 向量取指已推进 PC
    expect(bus.mem[0xFF0F]).toBe(0x00);
  });

  it('HALT 中优先级翻转：高优先级源后到仍先服务', () => {
    const { bus, cpu } = make([0x76]);
    bus.mem[0xFFFF] = 0x03;
    cpu.debugSet({ ime: true });
    cpu.step(); // HALT（此刻无挂起，正常停机）
    cpu.requestInterrupt(1); // 先挂 STAT
    cpu.requestInterrupt(0); // VBlank 也来了 → bit0 更优先
    cpu.step();
    expect(cpu.getState().pc).toBe(0x41); // 向量取指已推进 PC（重叠取指语义）
  });
});

describe('M3 中断：与取指流水交互', () => {
  it('latched opcode 执行 EI：处理程序首条 EI 正常 4T', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    bus.mem[0x40] = 0xFB; // handler: EI
    cpu.debugSet({ ime: true, pc: 0x0300 });
    expect(cpu.step()).toBe(20);
    expect(cpu.step()).toBe(0); // EI 是纯内部指令：取指已含在服务 20T 里，剩 0T
    expect(cpu.getState().ime).toBe(false); // EI 还没生效
    cpu.step(); // handler 里的下一条（mem[0x41]=0 → NOP）结束时 ime=true
    expect(cpu.getState().ime).toBe(true);
  });

  it('总周期账本：服务 20T 精确入账，重叠 NOP 计 0T', () => {
    const { bus, cpu } = make([0x00]);
    bus.mem[0xFFFF] = 0x01;
    bus.mem[0xFF0F] = 0x01;
    bus.mem[0x40] = 0x00;
    cpu.debugSet({ ime: true, pc: 0x0300 });
    cpu.step(); // 服务 20T
    expect(cpu.getState().totalCycles).toBe(20);
    cpu.step(); // 锁存的 NOP：0T
    expect(cpu.getState().totalCycles).toBe(20);
    cpu.step(); // 取下一条（mem[0x41]=0 → NOP）：4T
    expect(cpu.getState().totalCycles).toBe(24);
  });
});
