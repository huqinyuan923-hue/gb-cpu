import type { Bus, SM83 } from '../contract.js';
import { SM83Core } from './sm83.js';

/**
 * 冻结契约之外的调试面。
 * SM83Core 在满足 SM83 契约之外附加了两个调试能力（详见 README-偏差记录.md）：
 * - isLocked()：非法 opcode trap 后的锁死状态在契约的 CpuState 中无处安放，用只读口暴露；
 * - debugSet()：主板会话没有 boot ROM 时需要一个寄存器注入通道，否则无法把 PC 指到 $0100。
 */
export interface SM83Debug {
  isLocked(): boolean;
  debugSet(patch: Partial<import('../contract.js').CpuState>): void;
}

/** 公开入口：创建一个 SM83 CPU 实例 */
export function createSM83(bus: Bus): SM83 & SM83Debug {
  return new SM83Core(bus);
}
