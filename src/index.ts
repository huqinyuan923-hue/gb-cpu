/**
 * gb-cpu · SM83 CPU 部
 * 公开导出：冻结契约的全部类型/常量 + CPU 入口工厂。
 */
export * from './contract';
export { createSM83, type SM83Debug } from './cpu/createCPU';
export { SM83Core } from './cpu/sm83';
