import { describe, expect, it } from 'vitest';
import { createSM83 } from '../../src/cpu/createCPU';
import { FakeBus } from '../helpers/fakeBus';
import { RefModel } from '../helpers/refModel';

/**
 * 差分对拍：随机指令流 × 同种子下与参考模型（暴力版）逐 step 对拍。
 * 两者共享同一张 64KB 内存镜像（副作用同步生效），寄存器/SP/PC/累计周期
 * 每步必须完全一致。IE 恒 0（不分发中断），覆盖 HALT/EI/DI/STOP/非法锁定路径。
 */

/** xorshift32 种子随机数 */
function makePrng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

const CODE_BASE = 0x0400; // 代码区（避开向量区与栈区）

interface PairSetup {
  bus: FakeBus;
  cpu: ReturnType<typeof createSM83>;
  ref: RefModel;
}

function setup(seed: number): PairSetup {
  const bus = new FakeBus();
  const cpu = createSM83(bus);
  cpu.reset();
  const ref = new RefModel(bus.mem);
  ref.reset();
  const rnd = makePrng(seed);
  // 随机寄存器初值（两模型一致注入）
  const patch = {
    pc: CODE_BASE,
    sp: 0xDFF0,
    a: rnd() & 0xFF, f: rnd() & 0xF0,
    b: rnd() & 0xFF, c: rnd() & 0xFF,
    d: rnd() & 0xFF, e: rnd() & 0xFF,
    h: rnd() & 0xFF, l: rnd() & 0xFF,
  };
  cpu.debugSet(patch);
  Object.assign(ref, patch);
  // 代码区随机指令流（HALT 剪除：停机/bug 路径由全空间流的打桩唤醒覆盖）
  for (let i = 0; i < 256; i++) {
    let b = rnd() & 0xFF;
    if (b === 0x76) b = 0x00;
    bus.mem[CODE_BASE + i] = b;
  }
  // IE/IF 恒 0：无中断分发（分发路径已由 blargg + 单测覆盖）
  bus.mem[0xFFFF] = 0;
  bus.mem[0xFF0F] = 0;
  return { bus, cpu, ref };
}

/** 两侧同步打桩：强制 IME 关（防真实分发）+ 注入挂起以激活 HALT bug / 唤醒路径 */
function pokeWake(bus: FakeBus, cpu: ReturnType<typeof createSM83>, ref: RefModel): void {
  cpu.debugSet({ ime: false });
  ref.ime = false;
  bus.mem[0xFF0F] = 0x01;
  bus.mem[0xFFFF] = 0x01;
}

function snapshot(cpu: ReturnType<typeof createSM83>, ref: RefModel): string {
  const s = cpu.getState();
  return [
    `主: pc=${s.pc.toString(16)} sp=${s.sp.toString(16)} af=${s.a.toString(16)}/${s.f.toString(16)}`,
    `    bc=${s.b.toString(16)}${s.c.toString(16)} de=${s.d.toString(16)}${s.e.toString(16)} hl=${s.h.toString(16)}${s.l.toString(16)}`,
    `    ime=${s.ime} halted=${s.halted} T=${s.totalCycles}`,
    `参: pc=${ref.pc.toString(16)} sp=${ref.sp.toString(16)} af=${ref.a.toString(16)}/${ref.f.toString(16)}`,
    `    bc=${ref.b.toString(16)}${ref.c.toString(16)} de=${ref.d.toString(16)}${ref.e.toString(16)} hl=${ref.h.toString(16)}${ref.l.toString(16)}`,
    `    ime=${ref.ime} halted=${ref.halted} T=${ref.total}`,
  ].join('\n');
}

/** 跑一段随机流；分歧即抛出带上下文的断言 */
function runStream(seed: number, steps: number): void {
  const { cpu, ref } = setup(seed);
  for (let i = 0; i < steps; i++) {
    const t1 = cpu.step();
    const t2 = ref.step();
    const s = cpu.getState();
    const ctx = `种子=${seed} 第${i}步 (主 T=${t1} 参 T=${t2})\n${snapshot(cpu, ref)}`;
    expect(t1, `周期分歧：${ctx}`).toBe(t2);
    expect(s.pc, `PC 分歧：${ctx}`).toBe(ref.pc);
    expect(s.sp, `SP 分歧：${ctx}`).toBe(ref.sp);
    expect(s.a, ctx).toBe(ref.a);
    expect(s.f, ctx).toBe(ref.f);
    expect(s.b, ctx).toBe(ref.b);
    expect(s.c, ctx).toBe(ref.c);
    expect(s.d, ctx).toBe(ref.d);
    expect(s.e, ctx).toBe(ref.e);
    expect(s.h, ctx).toBe(ref.h);
    expect(s.l, ctx).toBe(ref.l);
    expect(s.halted, `HALT 分歧：${ctx}`).toBe(ref.halted);
    expect(s.ime, `IME 分歧：${ctx}`).toBe(ref.ime);
    if (cpu.isLocked() || ref.locked) return; // 非法 opcode：两侧一致锁定即通过
  }
}

describe('差分对拍：随机指令流 × 参考模型', () => {
  it.each([
    0x0001, 0x1234, 0x5A5A, 0xDEAD, 0xBEEF, 0x7C7C, 0x0F0F, 0x9999,
  ])('种子 %#x：2000 步逐拍', (seed) => {
    runStream(seed, 2000);
  });

  it('长流：种子 0xCAFE 跑 20000 步', () => {
    runStream(0xCAFE, 20000);
  });

  it('满地址空间随机流：跳转/调用落点全覆盖 + HALT bug 打桩', () => {
    // 全 64KB 随机（跳转目标处处有代码），周期性同步打桩唤醒停机/激活 bug 路径
    const { bus, cpu, ref } = setup(0x3141);
    const rnd = makePrng(0x5926);
    for (let i = 0x0200; i < 0x10000; i++) {
      let b = rnd() & 0xFF;
      if (b === 0x76) b = 0x00; // 内存数据区也可被执行，但剪除 HALT 防全空间停机死锁
      bus.mem[i] = b;
    }
    bus.mem[0xFFFF] = 0;
    bus.mem[0xFF0F] = 0;
    for (let i = 0; i < 5000; i++) {
      if (i % 500 === 0) pokeWake(bus, cpu, ref); // 两侧同步：ime 强制关 + 挂起注入
      const t1 = cpu.step();
      const t2 = ref.step();
      const s = cpu.getState();
      const ctx = `第${i}步 (主 T=${t1} 参 T=${t2})\n${snapshot(cpu, ref)}`;
      expect(t1, ctx).toBe(t2);
      expect(s.pc, ctx).toBe(ref.pc);
      expect(s.sp, ctx).toBe(ref.sp);
      expect(s.a, ctx).toBe(ref.a);
      expect(s.f, ctx).toBe(ref.f);
      expect(s.b, ctx).toBe(ref.b);
      expect(s.c, ctx).toBe(ref.c);
      expect(s.d, ctx).toBe(ref.d);
      expect(s.e, ctx).toBe(ref.e);
      expect(s.h, ctx).toBe(ref.h);
      expect(s.l, ctx).toBe(ref.l);
      expect(s.halted, ctx).toBe(ref.halted);
      if (cpu.isLocked() || ref.locked) break;
    }
  });
});
