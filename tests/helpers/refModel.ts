import type { u8, u16 } from '../../src/contract';

/**
 * SM83 参考模型（暴力版）：与主实现（总线活动周期账本）完全独立的第二实现。
 * - 周期：静态表直查（与主实现的"按总线活动累计"互为对照）；
 * - 语义：平铺 switch 重写一遍（与主实现的分组派发互为对照）；
 * - 内存：与被测 CPU 共享同一张 64KB 镜像，读写副作用同步生效。
 *
 * 差分对拍：随机指令流上逐 step 比对寄存器/SP/PC/累计周期，任一分歧即报警。
 * 范围说明：本模型不含中断分发（对拍时 IE 保持 0），含 HALT/EI/DI/STOP/非法锁定。
 */

const ILLEGAL = new Set([0xD3, 0xDB, 0xDD, 0xE3, 0xE4, 0xEB, 0xEC, 0xED, 0xF4, 0xFC, 0xFD]);

export class RefModel {
  a = 0; f = 0; b = 0; c = 0; d = 0; e = 0; h = 0; l = 0;
  sp = 0; pc = 0;
  ime = false;
  halted = false;
  locked = false;
  total = 0;
  /** EI 延迟：0=无；1=本指令结束后生效 */
  private eiDelay = 0;
  /** HALT bug 锁存 */
  private bugPending = false;

  constructor(readonly mem: Uint8Array) {}

  reset(): void {
    this.a = this.f = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.sp = this.pc = 0;
    this.ime = false;
    this.halted = false;
    this.locked = false;
    this.total = 0;
    this.eiDelay = 0;
    this.bugPending = false;
  }

  private rd(addr: number): u8 {
    return this.mem[addr & 0xFFFF] ?? 0;
  }
  private wr(addr: number, v: number): void {
    this.mem[addr & 0xFFFF] = v & 0xFF;
  }
  private fetch(): u8 {
    if (this.bugPending) {
      // HALT bug：取指不递增 PC
      this.bugPending = false;
      return this.rd(this.pc);
    }
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    return v;
  }
  private fetchN(): u8 {
    const v = this.rd(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    return v;
  }
  private fetchNN(): u16 {
    const lo = this.fetchN();
    const hi = this.fetchN();
    return lo | (hi << 8);
  }
  private push(v: u16): void {
    this.sp = (this.sp - 1) & 0xFFFF;
    this.wr(this.sp, (v >> 8) & 0xFF);
    this.sp = (this.sp - 1) & 0xFFFF;
    this.wr(this.sp, v & 0xFF);
  }
  private pop(): u16 {
    const lo = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xFFFF;
    const hi = this.rd(this.sp);
    this.sp = (this.sp + 1) & 0xFFFF;
    return lo | (hi << 8);
  }

  private get hl(): u16 { return ((this.h << 8) | this.l) & 0xFFFF; }
  private set hl(v: u16) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }
  private get bc(): u16 { return ((this.b << 8) | this.c) & 0xFFFF; }
  private set bc(v: u16) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  private get de(): u16 { return ((this.d << 8) | this.e) & 0xFFFF; }
  private set de(v: u16) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }

  // —— 标志写入（与主实现不同的表述：直接合成 f 字节）——
  private setFlags(z: boolean, n: boolean, h: boolean, cy: boolean): void {
    this.f = ((z ? 1 : 0) << 7) | ((n ? 1 : 0) << 6) | ((h ? 1 : 0) << 5) | ((cy ? 1 : 0) << 4);
  }
  private keepC(z: boolean, n: boolean, h: boolean): void {
    const cy = (this.f & 0x10) !== 0;
    this.setFlags(z, n, h, cy);
  }
  private z(): boolean { return (this.f & 0x80) !== 0; }
  private cy(): boolean { return (this.f & 0x10) !== 0; }

  /** 条件 0=NZ 1=Z 2=NC 3=C */
  private cond(y: number): boolean {
    const zz = this.z(), cc = this.cy();
    return y === 0 ? !zz : y === 1 ? zz : y === 2 ? !cc : cc;
  }

  /** 8 位寄存器索引 0-7；6 = (HL) 的读写 */
  private r8(i: number): u8 {
    return [this.b, this.c, this.d, this.e, this.h, this.l][i] ?? (i === 6 ? this.rd(this.hl) : this.a);
  }
  private w8(i: number, v: u8): void {
    if (i === 0) this.b = v;
    else if (i === 1) this.c = v;
    else if (i === 2) this.d = v;
    else if (i === 3) this.e = v;
    else if (i === 4) this.h = v;
    else if (i === 5) this.l = v;
    else if (i === 6) this.wr(this.hl, v);
    else this.a = v;
  }

  /** 一步；返回周期数。锁定后返回 4 且状态冻结。 */
  step(): number {
    if (this.locked) {
      this.total += 4;
      return 4;
    }
    if (this.halted) {
      // 与主实现一致：无挂起→维持停机 4T；IME=0 且有挂起→唤醒 4T；
      // IME=1 且有挂起→本模型无分发能力，对拍测试侧保证不会走到（打桩强制 ime=0）
      const pending = this.rd(0xFFFF) & this.rd(0xFF0F) & 0x1F;
      if (pending === 0 || this.ime) {
        this.total += 4;
        return 4;
      }
      this.halted = false;
      this.total += 4;
      return 4;
    }
    const t = this.exec();
    this.total += t;
    // EI 延迟：EI 后晚一条指令生效（与主实现同一计数语义，独立书写）
    if (this.eiDelay > 0 && --this.eiDelay === 0) this.ime = true;
    return t;
  }

  private exec(): number {
    const op = this.fetch();
    if (ILLEGAL.has(op)) {
      this.locked = true;
      return 4;
    }
    const self = this;

    // —— 杂项 ——
    if (op === 0x00) return 4;
    if (op === 0x10) { self.fetchN(); return 8; } // STOP：填充字节
    if (op === 0x76) { // HALT
      const ie = self.rd(0xFFFF), ifr = self.rd(0xFF0F);
      if ((ie & ifr & 0x1F) !== 0 && !self.ime && self.eiDelay === 0) {
        self.bugPending = true; // 不停机，下条取指不递增
      } else {
        self.halted = true;
      }
      return 4;
    }
    if (op === 0xF3) { self.ime = false; self.eiDelay = 0; return 4; }
    if (op === 0xFB) { self.eiDelay = 2; return 4; }
    if (op === 0x27) { // DAA
      let a = self.a;
      const n = (self.f & 0x40) !== 0, h = (self.f & 0x20) !== 0, c = (self.f & 0x10) !== 0;
      let adj = 0, cy = c;
      if (!n) {
        if (h || (a & 0xF) > 9) adj += 6;
        if (c || a > 0x99) { adj += 0x60; cy = true; }
      } else {
        if (h) adj += 6;
        if (c) adj += 0x60;
      }
      a = n ? (a - adj) & 0xFF : (a + adj) & 0xFF;
      self.a = a;
      self.setFlags(a === 0, n, false, cy);
      return 4;
    }
    if (op === 0x2F) { self.a = ~self.a & 0xFF; self.f = (self.f & 0x90) | 0x60; return 4; }
    if (op === 0x37) { self.f = (self.f & 0x80) | 0x10; return 4; }
    if (op === 0x3F) { self.f = (self.f & 0x90) ^ 0x10; return 4; }

    // —— A 轮转（Z 恒 0）——
    if (op === 0x07 || op === 0x0F || op === 0x17 || op === 0x1F) {
      const v = self.a;
      let cy: boolean, r: number;
      if (op === 0x07) { cy = (v & 0x80) !== 0; r = ((v << 1) & 0xFF) | (cy ? 1 : 0); }
      else if (op === 0x0F) { cy = (v & 1) !== 0; r = (v >>> 1) | (cy ? 0x80 : 0); }
      else if (op === 0x17) { cy = (v & 0x80) !== 0; r = ((v << 1) & 0xFF) | (self.cy() ? 1 : 0); }
      else { cy = (v & 1) !== 0; r = (v >>> 1) | (self.cy() ? 0x80 : 0); }
      self.a = r & 0xFF;
      self.setFlags(false, false, false, cy);
      return 4;
    }

    // —— LD 固定寻址 ——
    if (op === 0x02) { self.wr(self.bc, self.a); return 8; }
    if (op === 0x12) { self.wr(self.de, self.a); return 8; }
    if (op === 0x22) { const p = self.hl; self.wr(p, self.a); self.hl = (p + 1) & 0xFFFF; return 8; }
    if (op === 0x32) { const p = self.hl; self.wr(p, self.a); self.hl = (p - 1) & 0xFFFF; return 8; }
    if (op === 0x0A) { self.a = self.rd(self.bc); return 8; }
    if (op === 0x1A) { self.a = self.rd(self.de); return 8; }
    if (op === 0x2A) { const p = self.hl; self.a = self.rd(p); self.hl = (p + 1) & 0xFFFF; return 8; }
    if (op === 0x3A) { const p = self.hl; self.a = self.rd(p); self.hl = (p - 1) & 0xFFFF; return 8; }
    if (op === 0x36) { self.wr(self.hl, self.fetchN()); return 12; }
    if (op === 0xE0) { const n = self.fetchN(); self.wr(0xFF00 | n, self.a); return 12; }
    if (op === 0xF0) { const n = self.fetchN(); self.a = self.rd(0xFF00 | n); return 12; }
    if (op === 0xE2) { self.wr(0xFF00 | self.c, self.a); return 8; }
    if (op === 0xF2) { self.a = self.rd(0xFF00 | self.c); return 8; }
    if (op === 0xEA) { const p = self.fetchNN(); self.wr(p, self.a); return 16; }
    if (op === 0xFA) { self.a = self.rd(self.fetchNN()); return 16; }
    if (op === 0x08) {
      const p = self.fetchNN();
      self.wr(p, self.sp & 0xFF);
      self.wr((p + 1) & 0xFFFF, (self.sp >> 8) & 0xFF);
      return 20;
    }

    // —— 16 位 LD 与栈 ——
    if (op === 0x01) { self.bc = self.fetchNN(); return 12; }
    if (op === 0x11) { self.de = self.fetchNN(); return 12; }
    if (op === 0x21) { self.hl = self.fetchNN(); return 12; }
    if (op === 0x31) { self.sp = self.fetchNN(); return 12; }
    if (op === 0xF9) { self.sp = self.hl; return 8; }
    if (op === 0xC5) { self.push(self.bc); return 16; }
    if (op === 0xD5) { self.push(self.de); return 16; }
    if (op === 0xE5) { self.push(self.hl); return 16; }
    if (op === 0xF5) { self.push(((self.a << 8) | self.f) & 0xFFFF); return 16; }
    if (op === 0xC1) { self.bc = self.pop(); return 12; }
    if (op === 0xD1) { self.de = self.pop(); return 12; }
    if (op === 0xE1) { self.hl = self.pop(); return 12; }
    if (op === 0xF1) {
      const v = self.pop();
      self.a = (v >> 8) & 0xFF;
      self.f = v & 0xF0;
      return 12;
    }

    // —— 立即数算术 ——
    if (op === 0xC6 || op === 0xCE || op === 0xD6 || op === 0xDE || op === 0xE6 || op === 0xEE || op === 0xF6 || op === 0xFE) {
      const n = self.fetchN();
      aluImm((op >> 3) & 7, n);
      return 8;
    }

    // —— 跳转/调用/返回 ——
    if (op === 0x18) {
      const off = signed(self.fetchN());
      self.pc = (self.pc + off) & 0xFFFF;
      return 12;
    }
    if (op === 0xC3) { self.pc = self.fetchNN(); return 16; }
    if (op === 0xE9) { self.pc = self.hl; return 4; }
    if (op === 0xC9) { self.pc = self.pop(); return 16; }
    if (op === 0xD9) { self.pc = self.pop(); self.ime = true; return 16; }
    if (op === 0xCD) {
      const p = self.fetchNN();
      self.push(self.pc);
      self.pc = p;
      return 24;
    }
    if ((op & 0xC7) === 0xC7) { // RST
      self.push(self.pc);
      self.pc = ((op >> 3) & 7) << 3;
      return 16;
    }
    if (op === 0x20 || op === 0x28 || op === 0x30 || op === 0x38) { // JR cc
      const off = signed(self.fetchN());
      if (self.cond((op >> 3) & 3)) {
        self.pc = (self.pc + off) & 0xFFFF;
        return 12;
      }
      return 8;
    }
    if (op === 0xC2 || op === 0xCA || op === 0xD2 || op === 0xDA) {
      const p = self.fetchNN();
      if (self.cond((op >> 3) & 3)) {
        self.pc = p;
        return 16;
      }
      return 12;
    }
    if (op === 0xC4 || op === 0xCC || op === 0xD4 || op === 0xDC) {
      const p = self.fetchNN();
      if (self.cond((op >> 3) & 3)) {
        self.push(self.pc);
        self.pc = p;
        return 24;
      }
      return 12;
    }
    if (op === 0xC0 || op === 0xC8 || op === 0xD0 || op === 0xD8) {
      if (self.cond((op >> 3) & 3)) {
        self.pc = self.pop();
        return 20;
      }
      return 8;
    }

    // —— CB 页 ——
    if (op === 0xCB) {
      const sub = self.fetchN();
      return 8 + cbExec(sub);
    }

    // —— SP 特殊 ——
    if (op === 0xE8) {
      const n = signed(self.fetchN());
      const u = n & 0xFF;
      const h = (self.sp & 0xF) + (u & 0xF) > 0xF;
      const cy = (self.sp & 0xFF) + u > 0xFF;
      self.sp = (self.sp + n) & 0xFFFF;
      self.setFlags(false, false, h, cy);
      return 16;
    }
    if (op === 0xF8) {
      const n = signed(self.fetchN());
      const u = n & 0xFF;
      const h = (self.sp & 0xF) + (u & 0xF) > 0xF;
      const cy = (self.sp & 0xFF) + u > 0xFF;
      self.hl = (self.sp + n) & 0xFFFF;
      self.setFlags(false, false, h, cy);
      return 12;
    }

    // —— 分组区间 ——
    if (op <= 0x3F && (op & 0xF) === 3) { // INC rr
      const p = (op >> 4) & 3;
      const v = p === 0 ? self.bc : p === 1 ? self.de : p === 2 ? self.hl : self.sp;
      const w = (v + 1) & 0xFFFF;
      if (p === 0) self.bc = w; else if (p === 1) self.de = w; else if (p === 2) self.hl = w; else self.sp = w;
      return 8;
    }
    if (op <= 0x3F && (op & 0xF) === 0xB) { // DEC rr
      const p = (op >> 4) & 3;
      const v = p === 0 ? self.bc : p === 1 ? self.de : p === 2 ? self.hl : self.sp;
      const w = (v - 1) & 0xFFFF;
      if (p === 0) self.bc = w; else if (p === 1) self.de = w; else if (p === 2) self.hl = w; else self.sp = w;
      return 8;
    }
    if (op <= 0x3F && (op & 0xF) === 9) { // ADD HL,rr
      const p = (op >> 4) & 3;
      const rr = p === 0 ? self.bc : p === 1 ? self.de : p === 2 ? self.hl : self.sp;
      const hl = self.hl;
      const h = ((hl & 0xFFF) + (rr & 0xFFF)) > 0xFFF;
      const cy = hl + rr > 0xFFFF;
      self.hl = (hl + rr) & 0xFFFF;
      self.f = (self.f & 0x80) | ((h ? 1 : 0) << 5) | ((cy ? 1 : 0) << 4);
      return 8;
    }
    if (op <= 0x3F && (op & 7) <= 6 && (op & 7) !== 3) { // INC/DEC r / LD r,n（组）
      const dst = (op >> 3) & 7;
      const pat = op & 0xC7;
      if (pat === 0x04) { // INC
        if (dst === 6) {
          const v = self.rd(self.hl);
          const r = (v + 1) & 0xFF;
          self.wr(self.hl, r);
          self.keepC(r === 0, false, (v & 0xF) === 0xF);
          return 12;
        }
        const v = self.r8(dst);
        const r = (v + 1) & 0xFF;
        self.w8(dst, r);
        self.keepC(r === 0, false, (v & 0xF) === 0xF);
        return 4;
      }
      if (pat === 0x05) { // DEC
        if (dst === 6) {
          const v = self.rd(self.hl);
          const r = (v - 1) & 0xFF;
          self.wr(self.hl, r);
          self.keepC(r === 0, true, (v & 0xF) === 0);
          return 12;
        }
        const v = self.r8(dst);
        const r = (v - 1) & 0xFF;
        self.w8(dst, r);
        self.keepC(r === 0, true, (v & 0xF) === 0);
        return 4;
      }
      self.w8(dst, self.fetchN()); // LD r,n
      return 8;
    }
    if (op >= 0x40 && op <= 0x7F) { // LD r,r'
      const src = op & 7, dst = (op >> 3) & 7;
      const v = src === 6 ? self.rd(self.hl) : self.r8(src);
      if (dst === 6) self.wr(self.hl, v);
      else self.w8(dst, v);
      return src === 6 || dst === 6 ? 8 : 4;
    }
    if (op >= 0x80 && op <= 0xBF) { // ALU A,r
      const src = op & 7;
      const v = src === 6 ? self.rd(self.hl) : self.r8(src);
      aluImm((op >> 3) & 7, v);
      return src === 6 ? 8 : 4;
    }
    // 覆盖不全（理论上到不了）：锁定
    self.locked = true;
    return 4;

    // —— 内嵌：ALU 运算（索引 0-7 = ADD/ADC/SUB/SBC/AND/XOR/OR/CP；CP 不写回）——
    function aluImm(idx: number, rhs: u8): void {
      const a = self.a;
      switch (idx) {
        case 0: { // ADD
          const s = a + rhs;
          self.a = s & 0xFF;
          self.setFlags((s & 0xFF) === 0, false, (a & 0xF) + (rhs & 0xF) > 0xF, s > 0xFF);
          return;
        }
        case 1: { // ADC
          const ci = self.cy() ? 1 : 0;
          const s = a + rhs + ci;
          self.a = s & 0xFF;
          self.setFlags((s & 0xFF) === 0, false, (a & 0xF) + (rhs & 0xF) + ci > 0xF, s > 0xFF);
          return;
        }
        case 2: { // SUB
          const d = a - rhs;
          self.a = d & 0xFF;
          self.setFlags((d & 0xFF) === 0, true, (a & 0xF) - (rhs & 0xF) < 0, d < 0);
          return;
        }
        case 3: { // SBC
          const ci = self.cy() ? 1 : 0;
          const d = a - rhs - ci;
          self.a = d & 0xFF;
          self.setFlags((d & 0xFF) === 0, true, (a & 0xF) - (rhs & 0xF) - ci < 0, d < 0);
          return;
        }
        case 4: { // AND
          self.a = a & rhs;
          self.setFlags((a & rhs) === 0, false, true, false);
          return;
        }
        case 5: { // XOR
          self.a = a ^ rhs;
          self.setFlags((a ^ rhs) === 0, false, false, false);
          return;
        }
        case 6: { // OR
          self.a = a | rhs;
          self.setFlags((a | rhs) === 0, false, false, false);
          return;
        }
        default: { // CP
          const d = a - rhs;
          self.setFlags((d & 0xFF) === 0, true, (a & 0xF) - (rhs & 0xF) < 0, d < 0);
          return;
        }
      }
    }

    // —— 内嵌：CB 页执行，返回除两次取指外的周期 ——
    function cbExec(sub: u8): number {
      const x = (sub >> 6) & 3, y = (sub >> 3) & 7, z = sub & 7;
      if (x === 0) { // 移位/循环
        const v = z === 6 ? self.rd(self.hl) : self.r8(z);
        const ci = self.cy() ? 1 : 0;
        let r: number, cy: boolean;
        switch (y) {
          case 0: cy = (v & 0x80) !== 0; r = ((v << 1) & 0xFE) | (cy ? 1 : 0); break;
          case 1: cy = (v & 1) !== 0; r = (v >>> 1) | (cy ? 0x80 : 0); break;
          case 2: cy = (v & 0x80) !== 0; r = ((v << 1) & 0xFF) | ci; break;
          case 3: cy = (v & 1) !== 0; r = (v >>> 1) | (ci ? 0x80 : 0); break;
          case 4: cy = (v & 0x80) !== 0; r = (v << 1) & 0xFF; break;
          case 5: cy = (v & 1) !== 0; r = ((v >>> 1) | (v & 0x80)) & 0xFF; break;
          case 6: cy = false; r = ((v << 4) | (v >>> 4)) & 0xFF; break;
          default: cy = (v & 1) !== 0; r = v >>> 1; break;
        }
        r &= 0xFF;
        if (z === 6) self.wr(self.hl, r); else self.w8(z, r);
        self.setFlags(r === 0, false, false, cy);
        return z === 6 ? 8 : 0;
      }
      if (x === 1) { // BIT
        const v = z === 6 ? self.rd(self.hl) : self.r8(z);
        const zz = (v & (1 << y)) === 0;
        self.f = (self.f & 0x10) | (zz ? 0x80 : 0) | 0x20;
        return z === 6 ? 4 : 0;
      }
      // RES / SET
      const bitMask = 1 << y;
      if (z === 6) {
        self.wr(self.hl, x === 2 ? self.rd(self.hl) & ~bitMask & 0xFF : self.rd(self.hl) | bitMask);
        return 8;
      }
      self.w8(z, x === 2 ? self.r8(z) & ~bitMask & 0xFF : self.r8(z) | bitMask);
      return 0;
    }
  }
}

function signed(v: u8): number {
  return v & 0x80 ? v - 0x100 : v;
}
