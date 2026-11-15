import type { Bus, CpuState, u8, u16 } from '../contract.js';
import { add8, add16, addSp, and8, bit, daa, dec8, inc8, or8, rotOp, sub8, xor8 } from './alu.js';
import type { BusWithTiming } from './timedBus.js';

/**
 * SM83 CPU 核心（Game Boy DMG）
 *
 * 设计要点：
 * - **周期账本按真实总线活动累加**：一次总线读/写 = 4T，一个内部 M 周期 = 4T，
 *   16 位操作数 = 两次 8 位访问。指令周期数不查表，是取指/读写/内部周期自然累计的结果。
 * - **IE/IF 是总线上（主板/中断控制器）的寄存器**：CPU 在指令边界经总线轮询
 *   `$FFFF`(IE) 与 `$FF0F`(IF)。轮询与中断应答（清 IF 位）在硬件上是片内信号，
 *   因此不计入周期账本。
 * - **中断服务 20T**：2 个内部 M 周期(8T) + PC 高字节入栈(4T) + 低字节入栈(4T)
 *   + 向量取指(4T)。向量取指读到的就是中断处理程序第一条指令的 opcode——硬件上
 *   该取指与中断序列重叠，本实现把它锁存（latchedOp），下一条指令不再重复取指。
 * - **非法 opcode trap**：DMG 上执行非法指令（$D3 等 11 个未分配码）CPU 即锁死。
 *   本实现置 locked，之后每次 step 空转 4T，寄存器不再变化。
 */
export class SM83Core {
  // ============ 寄存器 ============
  private a = 0;
  private f = 0; // 仅 bit7-4 有效（Z N H C）
  private b = 0;
  private c = 0;
  private d = 0;
  private e = 0;
  private h = 0;
  private l = 0;
  private sp = 0;
  private pc = 0;

  // ============ CPU 状态 ============
  private ime = false;
  private halted = false;
  private locked = false; // 非法 opcode trap：锁死后不再执行任何指令

  // ============ 周期账本 ============
  private totalCycles = 0; // 复位以来累计 T 周期
  private stepCycles = 0; // 当前 step() 已累计的 T 周期

  // ============ 时序敏感情态 ============
  /** EI 延迟计数：EI 置 2，每次指令边界递减，减到 0 时 IME=1（EI 后晚一条指令生效） */
  private eiDelay = 0;
  /** HALT bug 锁存：IME=0 且有挂起中断时执行 HALT，下一条取指 PC 不递增 */
  private haltBugLatched = false;
  /** 中断向量取指锁存：中断服务 20T 的最后一个 M 周期取到的 opcode */
  private latchedOp: u8 | null = null;

  constructor(private bus: Bus) {
    // 带时序总线为可选协议：实现了 readAt/writeAt 的总线获得 T 级访问位置
    this.timedBus = bus as BusWithTiming;
  }

  // ============================================================
  // 对外接口（契约）
  // ============================================================

  reset(): void {
    this.a = 0; this.f = 0; this.b = 0; this.c = 0;
    this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    this.sp = 0; this.pc = 0;
    this.ime = false;
    this.halted = false;
    this.locked = false;
    this.totalCycles = 0;
    this.stepCycles = 0;
    this.eiDelay = 0;
    this.haltBugLatched = false;
    this.latchedOp = null;
  }

  /** 执行一步：一条指令，或一次 20T 的中断服务（含向量取指） */
  step(): number {
    this.stepCycles = 0;

    if (this.locked) {
      // trap 后挂起：总线空转，寄存器不再变化
      this.idle();
    } else {
      const pending = this.pendingInterrupts();
      if (this.halted) {
        if (pending === 0) {
          this.idle(); // 维持 HALT：每步一个内部 M 周期
        } else if (this.ime) {
          this.dispatchInterrupt(pending); // HALT 中直接转入中断服务
        } else {
          this.halted = false; // IME=0：挂起中断把 CPU 唤醒（不服务）
          this.idle();
        }
      } else if (this.ime && pending !== 0) {
        this.dispatchInterrupt(pending); // 指令边界：中断服务优先于下一条指令
      } else {
        this.executeInstruction();
        // EI 延迟：EI 之后第一条指令完成时生效
        if (this.eiDelay > 0 && --this.eiDelay === 0) this.ime = true;
      }
    }

    this.totalCycles += this.stepCycles;
    return this.stepCycles;
  }

  /** 外设请求中断：把对应 bit 置入总线 IF（$FF0F） */
  requestInterrupt(bit: u8): void {
    if (bit > 4) return; // DMG 仅 5 个中断源
    const ifReg = this.bus.read(0xFF0F);
    this.bus.write(0xFF0F, ifReg | (1 << bit));
  }

  getState(): CpuState {
    return {
      a: this.a, f: this.f, b: this.b, c: this.c,
      d: this.d, e: this.e, h: this.h, l: this.l,
      sp: this.sp, pc: this.pc,
      ime: this.ime,
      halted: this.halted,
      totalCycles: this.totalCycles,
    };
  }

  // ============================================================
  // 调试面（冻结契约之外的附加能力，见 README-偏差记录.md）
  // ============================================================

  /** 非法 opcode trap 后是否锁死 */
  isLocked(): boolean {
    return this.locked;
  }

  /** 调试注入寄存器状态（主板无 boot ROM 启动时用） */
  debugSet(patch: Partial<CpuState>): void {
    if (patch.a !== undefined) this.a = patch.a & 0xFF;
    if (patch.f !== undefined) this.f = patch.f & 0xF0;
    if (patch.b !== undefined) this.b = patch.b & 0xFF;
    if (patch.c !== undefined) this.c = patch.c & 0xFF;
    if (patch.d !== undefined) this.d = patch.d & 0xFF;
    if (patch.e !== undefined) this.e = patch.e & 0xFF;
    if (patch.h !== undefined) this.h = patch.h & 0xFF;
    if (patch.l !== undefined) this.l = patch.l & 0xFF;
    if (patch.sp !== undefined) this.sp = patch.sp & 0xFFFF;
    if (patch.pc !== undefined) this.pc = patch.pc & 0xFFFF;
    if (patch.ime !== undefined) this.ime = patch.ime;
    if (patch.halted !== undefined) this.halted = patch.halted;
    if (patch.totalCycles !== undefined) this.totalCycles = patch.totalCycles;
  }

  // ============================================================
  // 微操作：周期账本的唯一记账点
  // ============================================================

  private readonly timedBus: BusWithTiming | null;

  /** 总线读：一个 M 周期 = 4T；带时序总线则附带步内 T 位置 */
  private read8(addr: u16): u8 {
    const a = addr & 0xFFFF;
    if (this.timedBus?.readAt) {
      const v = this.timedBus.readAt(a, this.stepCycles);
      this.stepCycles += 4;
      return v;
    }
    this.stepCycles += 4;
    return this.bus.read(a);
  }

  /** 总线写：一个 M 周期 = 4T；带时序总线则附带步内 T 位置 */
  private write8(addr: u16, v: u8): void {
    const a = addr & 0xFFFF;
    if (this.timedBus?.writeAt) {
      this.timedBus.writeAt(a, v & 0xFF, this.stepCycles);
      this.stepCycles += 4;
      return;
    }
    this.stepCycles += 4;
    this.bus.write(a, v & 0xFF);
  }

  /** 取一个操作数字节（PC 递增） */
  private fetch8(): u8 {
    const v = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    return v;
  }

  /** 取 16 位操作数：低字节在前 */
  private fetch16(): u16 {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return lo | (hi << 8);
  }

  /** 取 opcode：HALT bug 锁存时 PC 不递增（该字节被读两次） */
  private fetchOpcode(): u8 {
    if (this.haltBugLatched) {
      this.haltBugLatched = false;
      return this.read8(this.pc); // 不递增 PC —— HALT bug 的全部效应
    }
    return this.fetch8();
  }

  /** 内部 M 周期：4T，无总线活动 */
  private idle(): void {
    this.stepCycles += 4;
  }

  // ---- 中断轮询与应答（硬件上是片内信号，不占总线周期）----

  private pendingInterrupts(): u8 {
    return this.bus.read(0xFFFF) & this.bus.read(0xFF0F) & 0x1F;
  }

  /** 中断服务（20T）：置 IME=0、PC 入栈、跳向量、锁存向量取指 */
  private dispatchInterrupt(pending: u8): void {
    // bit0 → bit4 优先级递减
    let bitNo = 0;
    while ((pending & (1 << bitNo)) === 0) bitNo++;
    const vector = 0x40 + bitNo * 8;

    // 应答：清 IF 对应位（经总线写回，片内信号不计账）
    this.bus.write(0xFF0F, this.bus.read(0xFF0F) & ~(1 << bitNo));
    this.haltBugLatched = false; // 应答路径吞掉悬置的 HALT bug
    this.ime = false;
    this.halted = false;

    this.idle(); // 内部 M 周期 ×2（硬件中断序列前两个节拍）
    this.idle();
    this.push16(this.pc); // PC 高字节先入栈
    this.pc = vector;
    this.latchedOp = this.fetchOpcode(); // 向量取指 = 处理程序首条指令的 opcode
  }

  // ============================================================
  // 栈与 16 位寄存器对
  // ============================================================

  private push16(v: u16): void {
    this.sp = (this.sp - 1) & 0xFFFF;
    this.write8(this.sp, (v >> 8) & 0xFF); // 高字节先入栈
    this.sp = (this.sp - 1) & 0xFFFF;
    this.write8(this.sp, v & 0xFF);
  }

  private pop16(): u16 {
    const lo = this.read8(this.sp);
    this.sp = (this.sp + 1) & 0xFFFF;
    const hi = this.read8(this.sp);
    this.sp = (this.sp + 1) & 0xFFFF;
    return lo | (hi << 8);
  }

  private get bc(): u16 { return (this.b << 8) | this.c; }
  private set bc(v: u16) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  private get de(): u16 { return (this.d << 8) | this.e; }
  private set de(v: u16) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
  private get hl(): u16 { return (this.h << 8) | this.l; }
  private set hl(v: u16) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
  private get af(): u16 { return (this.a << 8) | this.f; }
  private set af(v: u16) { this.a = (v >> 8) & 0xFF; this.f = v & 0xF0; }

  // ============================================================
  // 标志
  // ============================================================

  private fz(): boolean { return (this.f & 0x80) !== 0; }
  private fn(): boolean { return (this.f & 0x40) !== 0; }
  private fh(): boolean { return (this.f & 0x20) !== 0; }
  private fc(): boolean { return (this.f & 0x10) !== 0; }

  private setF(z: boolean, n: boolean, h: boolean, c: boolean): void {
    this.f = (z ? 0x80 : 0) | (n ? 0x40 : 0) | (h ? 0x20 : 0) | (c ? 0x10 : 0);
  }

  /** 条件码：0=NZ 1=Z 2=NC 3=C */
  private cond(y: number): boolean {
    switch (y & 3) {
      case 0: return !this.fz();
      case 1: return this.fz();
      case 2: return !this.fc();
      default: return this.fc();
    }
  }

  // ============================================================
  // 8 位寄存器索引访问：0=B 1=C 2=D 3=E 4=H 5=L 6=(HL) 7=A
  // （索引 6 的读写是真实总线活动，自动进周期账本）
  // ============================================================

  private regGet(i: number): u8 {
    switch (i) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.read8(this.hl);
      default: return this.a;
    }
  }

  private regSet(i: number, v: u8): void {
    switch (i) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      case 6: this.write8(this.hl, v); break;
      default: this.a = v; break;
    }
  }

  // ============================================================
  // 执行：取指 + 派发
  // ============================================================

  private executeInstruction(): void {
    if (this.latchedOp !== null) {
      // 中断服务 20T 的向量取指已锁存：这条指令不再花取指周期
      const op = this.latchedOp;
      this.latchedOp = null;
      this.run(op);
    } else {
      this.run(this.fetchOpcode());
    }
  }

  /** 带符号 8 位（JR 偏移 / ADD SP,n） */
  private static signed(v: u8): number {
    return v & 0x80 ? v - 0x100 : v;
  }

  private run(op: u8): void {
    switch (op) {
      // ============ 控制与杂项 ============
      case 0x00: // NOP
        return;
      case 0x10: { // STOP：DMG 上再取一个填充字节后继续（整机停机语义归主板，偏差记录在案）
        this.fetch8();
        return;
      }
      case 0x76: { // HALT
        const pending = this.pendingInterrupts();
        if (!this.ime && this.eiDelay === 0 && pending !== 0) {
          this.haltBugLatched = true; // HALT bug：不真停机，下一条取指 PC 不递增
        } else {
          this.halted = true;
        }
        return;
      }
      case 0xF3: // DI：立即生效，并取消悬置中的 EI
        this.ime = false;
        this.eiDelay = 0;
        return;
      case 0xFB: // EI：延迟一条指令生效
        this.eiDelay = 2;
        return;
      case 0x27: { // DAA
        const r = daa(this.a, this.fn(), this.fh(), this.fc());
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 0x2F: // CPL：N=H=1，Z/C 保持
        this.a = ~this.a & 0xFF;
        this.f |= 0x60;
        return;
      case 0x37: // SCF：N=H=0，C=1，Z 保持
        this.f = (this.f & 0x80) | 0x10;
        return;
      case 0x3F: // CCF：N=H=0，C 取反，Z 保持
        this.f = (this.f & 0x90) ^ 0x10;
        return;

      // ============ A 寄存器轮转（老式四条：Z 恒为 0） ============
      case 0x07: { // RLCA
        const r = rotOp(0, this.a, false);
        this.a = r.v;
        this.setF(false, false, false, r.c); // Z=0（硬件特性）
        return;
      }
      case 0x0F: { // RRCA
        const r = rotOp(1, this.a, false);
        this.a = r.v;
        this.setF(false, false, false, r.c);
        return;
      }
      case 0x17: { // RLA
        const r = rotOp(2, this.a, this.fc());
        this.a = r.v;
        this.setF(false, false, false, r.c);
        return;
      }
      case 0x1F: { // RRA
        const r = rotOp(3, this.a, this.fc());
        this.a = r.v;
        this.setF(false, false, false, r.c);
        return;
      }

      // ============ 8 位 LD（固定寻址） ============
      case 0x02: this.write8(this.bc, this.a); return; // LD (BC),A
      case 0x12: this.write8(this.de, this.a); return; // LD (DE),A
      case 0x0A: this.a = this.read8(this.bc); return; // LD A,(BC)
      case 0x1A: this.a = this.read8(this.de); return; // LD A,(DE)
      case 0x22: { // LD (HL+),A
        const addr = this.hl;
        this.write8(addr, this.a);
        this.hl = (addr + 1) & 0xFFFF;
        return;
      }
      case 0x32: { // LD (HL-),A
        const addr = this.hl;
        this.write8(addr, this.a);
        this.hl = (addr - 1) & 0xFFFF;
        return;
      }
      case 0x2A: { // LD A,(HL+)
        const addr = this.hl;
        this.a = this.read8(addr);
        this.hl = (addr + 1) & 0xFFFF;
        return;
      }
      case 0x3A: { // LD A,(HL-)
        const addr = this.hl;
        this.a = this.read8(addr);
        this.hl = (addr - 1) & 0xFFFF;
        return;
      }
      case 0x36: this.write8(this.hl, this.fetch8()); return; // LD (HL),n
      case 0xE0: { // LDH (n),A：$FF00+n
        const n = this.fetch8();
        this.write8(0xFF00 | n, this.a);
        return;
      }
      case 0xF0: { // LDH A,(n)
        const n = this.fetch8();
        this.a = this.read8(0xFF00 | n);
        return;
      }
      case 0xE2: this.write8(0xFF00 | this.c, this.a); return; // LD (C),A
      case 0xF2: this.a = this.read8(0xFF00 | this.c); return; // LD A,(C)
      case 0xEA: { // LD (nn),A
        const addr = this.fetch16();
        this.write8(addr, this.a);
        return;
      }
      case 0xFA: this.a = this.read8(this.fetch16()); return; // LD A,(nn)
      case 0x08: { // LD (nn),SP：低字节先写
        const addr = this.fetch16();
        this.write8(addr, this.sp & 0xFF);
        this.write8((addr + 1) & 0xFFFF, (this.sp >> 8) & 0xFF);
        return;
      }

      // ============ 16 位 LD 与栈 ============
      case 0x01: this.bc = this.fetch16(); return;
      case 0x11: this.de = this.fetch16(); return;
      case 0x21: this.hl = this.fetch16(); return;
      case 0x31: this.sp = this.fetch16(); return;
      case 0xF9: { // LD SP,HL：取指 + 内部
        this.idle();
        this.sp = this.hl;
        return;
      }
      case 0xC5: { this.idle(); this.push16(this.bc); return; } // PUSH BC
      case 0xD5: { this.idle(); this.push16(this.de); return; } // PUSH DE
      case 0xE5: { this.idle(); this.push16(this.hl); return; } // PUSH HL
      case 0xF5: { this.idle(); this.push16(this.af); return; } // PUSH AF
      case 0xC1: this.bc = this.pop16(); return; // POP BC
      case 0xD1: this.de = this.pop16(); return; // POP DE
      case 0xE1: this.hl = this.pop16(); return; // POP HL
      case 0xF1: { // POP AF：F 仅 4 个标志位有效
        const v = this.pop16();
        this.a = (v >> 8) & 0xFF;
        this.f = v & 0xF0;
        return;
      }

      // ============ 立即数算术 ============
      case 0xC6: { // ADD A,n
        const r = add8(this.a, this.fetch8(), false);
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 0xCE: { // ADC A,n
        const r = add8(this.a, this.fetch8(), this.fc());
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 0xD6: { // SUB n
        const r = sub8(this.a, this.fetch8(), false);
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 0xDE: { // SBC A,n
        const r = sub8(this.a, this.fetch8(), this.fc());
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 0xE6: { // AND n
        const r = and8(this.a, this.fetch8());
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 0xEE: { // XOR n
        const r = xor8(this.a, this.fetch8());
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 0xF6: { // OR n
        const r = or8(this.a, this.fetch8());
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 0xFE: { // CP n：只更新标志
        const r = sub8(this.a, this.fetch8(), false);
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }

      // ============ 跳转 / 调用 / 返回 ============
      case 0x18: { // JR n：必跳
        const off = SM83Core.signed(this.fetch8());
        this.idle();
        this.pc = (this.pc + off) & 0xFFFF;
        return;
      }
      case 0xC3: { // JP nn
        const addr = this.fetch16();
        this.idle();
        this.pc = addr;
        return;
      }
      case 0xE9: this.pc = this.hl; return; // JP (HL)：仅取指
      case 0xC9: { // RET
        this.idle();
        this.pc = this.pop16();
        return;
      }
      case 0xD9: { // RETI：返回并立即开中断
        this.idle();
        this.pc = this.pop16();
        this.ime = true;
        return;
      }
      case 0xCD: { // CALL nn
        const addr = this.fetch16();
        this.idle();
        this.push16(this.pc);
        this.pc = addr;
        return;
      }
      case 0xC7: case 0xCF: case 0xD7: case 0xDF: // RST $00/$08/$10/$18
      case 0xE7: case 0xEF: case 0xF7: case 0xFF: { // RST $20/$28/$30/$38
        this.idle();
        this.push16(this.pc);
        this.pc = ((op >> 3) & 7) << 3;
        return;
      }

      // ============ CB 前缀页 ============
      case 0xCB:
        this.runCB(this.fetch8());
        return;

      // ============ 条件跳转 / 调用 / 返回 ============
      case 0x20: case 0x28: case 0x30: case 0x38: { // JR cc,n
        const off = SM83Core.signed(this.fetch8());
        if (this.cond((op >> 3) & 3)) {
          this.idle();
          this.pc = (this.pc + off) & 0xFFFF;
        }
        return;
      }
      case 0xC2: case 0xCA: case 0xD2: case 0xDA: { // JP cc,nn
        const addr = this.fetch16();
        if (this.cond((op >> 3) & 3)) {
          this.idle();
          this.pc = addr;
        }
        return;
      }
      case 0xC4: case 0xCC: case 0xD4: case 0xDC: { // CALL cc,nn
        const addr = this.fetch16();
        if (this.cond((op >> 3) & 3)) {
          this.idle();
          this.push16(this.pc);
          this.pc = addr;
        }
        return;
      }
      case 0xC0: case 0xC8: case 0xD0: case 0xD8: { // RET cc：跳过 8T / 执行 20T
        if (this.cond((op >> 3) & 3)) {
          this.idle();
          this.idle();
          this.pc = this.pop16();
        } else {
          this.idle();
        }
        return;
      }

      // ============ 非法 opcode（11 个未分配码）：DMG 执行即锁死 ============
      case 0xD3: case 0xDB: case 0xDD: case 0xE3: case 0xE4:
      case 0xEB: case 0xEC: case 0xED: case 0xF4: case 0xFC: case 0xFD:
        this.locked = true;
        return;

      // ============ 规则区间（default）============
      default: {
        // ---- 16 位组：INC rr / ADD HL,rr / DEC rr（LD rr,nn 已显式处理）----
        if (op <= 0x3F && ((op & 0x0F) === 0x03 || (op & 0x0F) === 0x09 || (op & 0x0F) === 0x0B)) {
          const pair = (op >> 4) & 3; // 0=BC 1=DE 2=HL 3=SP
          switch (op & 0x0F) {
            case 0x03: { // INC rr：取指 + 内部，无标志
              this.idle();
              this.setPair(pair, (this.getPair(pair) + 1) & 0xFFFF);
              return;
            }
            case 0x09: { // ADD HL,rr：取指 + 内部
              const r = add16(this.hl, this.getPair(pair));
              this.idle();
              this.hl = r.v;
              this.f = (this.f & 0x80) | (r.h ? 0x20 : 0) | (r.c ? 0x10 : 0); // N=0，Z 保持
              return;
            }
            default: { // 0x0B：DEC rr，取指 + 内部，无标志
              this.idle();
              this.setPair(pair, (this.getPair(pair) - 1) & 0xFFFF);
              return;
            }
          }
        }
        // ---- 8 位组：INC r / DEC r / LD r,n（0x04-0x3E 的规则区间）----
        if (op <= 0x3F && (op & 7) <= 6) {
          const pattern = op & 0xC7; // 0x04=INC 0x05=DEC 0x06=LD r,n
          const dst = (op >> 3) & 7; // 目标寄存器索引（6 = (HL)）
          if (pattern === 0x04) {
            if (dst === 6) { // INC (HL)：读 + 写（ALU 在写拍内完成，无独立内部周期）
              const r = inc8(this.read8(this.hl));
              this.write8(this.hl, r.v);
              this.f = (this.f & 0x10) | (r.z ? 0x80 : 0) | (r.h ? 0x20 : 0); // N=0，C 保持
            } else { // INC r
              const r = inc8(this.regGet(dst));
              this.regSet(dst, r.v);
              this.f = (this.f & 0x10) | (r.z ? 0x80 : 0) | (r.h ? 0x20 : 0);
            }
            return;
          }
          if (pattern === 0x05) {
            if (dst === 6) { // DEC (HL)
              const r = dec8(this.read8(this.hl));
              this.write8(this.hl, r.v);
              this.f = (this.f & 0x10) | 0x40 | (r.z ? 0x80 : 0) | (r.h ? 0x20 : 0); // N=1
            } else { // DEC r
              const r = dec8(this.regGet(dst));
              this.regSet(dst, r.v);
              this.f = (this.f & 0x10) | 0x40 | (r.z ? 0x80 : 0) | (r.h ? 0x20 : 0);
            }
            return;
          }
          // LD r,n（dst===6 即 0x36，已在显式 case 处理，不会到达）
          this.regSet(dst, this.fetch8());
          return;
        }
        // ---- LD r,r'（0x40-0x7F，0x76=HALT 已显式）----
        if (op >= 0x40 && op <= 0x7F) {
          this.regSet((op >> 3) & 7, this.regGet(op & 7));
          return;
        }
        // ---- ALU A,r（0x80-0xBF）----
        if (op >= 0x80 && op <= 0xBF) {
          this.aluA((op >> 3) & 7, this.regGet(op & 7));
          return;
        }
        // ---- SP 特殊指令 ----
        if (op === 0xE8) { // ADD SP,n：取指 + 读 n + 内部 + 内部（16T）
          const r = addSp(this.sp, SM83Core.signed(this.fetch8()));
          this.idle();
          this.idle();
          this.sp = r.v;
          this.setF(false, false, r.h, r.c); // Z=N=0
          return;
        }
        if (op === 0xF8) { // LD HL,SP+n：取指 + 读 n + 内部（12T）
          const r = addSp(this.sp, SM83Core.signed(this.fetch8()));
          this.idle();
          this.hl = r.v;
          this.setF(false, false, r.h, r.c);
          return;
        }
        unreachable(op);
      }
    }
  }

  /** ALU A,r 区间的 8 种运算（索引 0-7 对应 ADD/ADC/SUB/SBC/AND/XOR/OR/CP） */
  private aluA(aluOp: number, rhs: u8): void {
    switch (aluOp) {
      case 0: { // ADD A,r
        const r = add8(this.a, rhs, false);
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 1: { // ADC A,r
        const r = add8(this.a, rhs, this.fc());
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 2: { // SUB r
        const r = sub8(this.a, rhs, false);
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 3: { // SBC A,r
        const r = sub8(this.a, rhs, this.fc());
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 4: { // AND r
        const r = and8(this.a, rhs);
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 5: { // XOR r
        const r = xor8(this.a, rhs);
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      case 6: { // OR r
        const r = or8(this.a, rhs);
        this.a = r.v;
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
      default: { // CP r：只更新标志
        const r = sub8(this.a, rhs, false);
        this.setF(r.z, r.n, r.h, r.c);
        return;
      }
    }
  }

  private getPair(pair: number): u16 {
    switch (pair) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.hl;
      default: return this.sp;
    }
  }

  private setPair(pair: number, v: u16): void {
    switch (pair) {
      case 0: this.bc = v; break;
      case 1: this.de = v; break;
      case 2: this.hl = v; break;
      default: this.sp = v; break;
    }
  }

  // ============================================================
  // CB 前缀页（256 条）：x = 高 2 位，y = 中 3 位，z = 低 3 位
  // ============================================================

  private runCB(sub: u8): void {
    const x = (sub >> 6) & 3;
    const y = (sub >> 3) & 7;
    const z = sub & 7;
    switch (x) {
      case 0: { // RLC/RRC/RL/RR/SLA/SRA/SWAP/SRL y,z
        const carryIn = this.fc();
        if (z === 6) { // (HL)：读 + 写（16T = 2 取指 + 读 + 写）
          const r = rotOp(y, this.read8(this.hl), carryIn);
          this.write8(this.hl, r.v);
          this.setF(r.z, r.n, r.h, r.c);
        } else { // 寄存器（8T = 2 取指）
          const r = rotOp(y, this.regGet(z), carryIn);
          this.regSet(z, r.v);
          this.setF(r.z, r.n, r.h, r.c);
        }
        return;
      }
      case 1: { // BIT y,z：N=0，H=1，C 保持
        const v = z === 6 ? this.read8(this.hl) : this.regGet(z);
        const b = bit(v, y);
        this.f = (this.f & 0x10) | (b.z ? 0x80 : 0) | 0x20;
        return;
      }
      case 2: { // RES y,z：无标志
        if (z === 6) {
          this.write8(this.hl, this.read8(this.hl) & ~(1 << y) & 0xFF);
        } else {
          this.regSet(z, this.regGet(z) & (~(1 << y) & 0xFF));
        }
        return;
      }
      default: { // SET y,z：无标志
        if (z === 6) {
          this.write8(this.hl, this.read8(this.hl) | (1 << y));
        } else {
          this.regSet(z, this.regGet(z) | (1 << y));
        }
        return;
      }
    }
  }
}

/** 派发穷尽性守护：理论上不可达的 opcode */
function unreachable(op: u8): never {
  throw new Error(`SM83 派发遗漏：opcode $${op.toString(16).padStart(2, '0').toUpperCase()}`);
}
