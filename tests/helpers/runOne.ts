import { createSM83, type SM83Debug } from '../../src/cpu/createCPU';
import { FakeBus } from './fakeBus';
import type { CpuState, SM83, u16, u8 } from '../../src/contract';

/**
 * 单步测试工具：把一段指令摆进假总线，跑一条，断言寄存器/标志/周期/内存副作用。
 */
export interface StepResult {
  cycles: number;
  state: CpuState;
  bus: FakeBus;
  cpu: SM83 & SM83Debug;
}

/** 默认代码基址（相当于真实卡带入口 $0100） */
export const BASE = 0x0100;

/**
 * 跑一条指令：
 * - bytes 摆在 base 起；
 * - patch 注入寄存器初值（默认 PC=base、SP=0xFFFE）；
 * - 可选 pre/post 对总线内存的预置与读取。
 */
export function runOne(
  bytes: readonly number[],
  patch: Partial<CpuState> = {},
  base: u16 = BASE,
  pre?: (bus: FakeBus) => void,
): StepResult {
  const bus = new FakeBus();
  const cpu = createSM83(bus);
  cpu.reset();
  bus.setBytes(base, bytes);
  pre?.(bus);
  cpu.debugSet({ pc: base, sp: 0xFFFE, ...patch });
  const cycles = cpu.step();
  return { cycles, state: cpu.getState(), bus, cpu };
}

/** 连续跑 N 条（用于多指令铺垫） */
export function runN(
  bytes: readonly number[],
  n: number,
  patch: Partial<CpuState> = {},
  base: u16 = BASE,
  pre?: (bus: FakeBus) => void,
): StepResult {
  const bus = new FakeBus();
  const cpu = createSM83(bus);
  cpu.reset();
  bus.setBytes(base, bytes);
  pre?.(bus);
  cpu.debugSet({ pc: base, sp: 0xFFFE, ...patch });
  let cycles = 0;
  for (let i = 0; i < n; i++) cycles += cpu.step();
  return { cycles, state: cpu.getState(), bus, cpu };
}

/** 写一个 16 位立即数的两个字节（低在前） */
export function le16(v: u16): [u8, u8] {
  return [v & 0xFF, (v >> 8) & 0xFF];
}
