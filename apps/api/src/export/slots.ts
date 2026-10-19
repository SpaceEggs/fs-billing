const MAX_EXPORTS_PER_PROCESS = 4;

/** Process-local admission: one export per tenant and four per process. */
export class ExportSlots {
  private readonly activeTenants = new Map<string, symbol>();
  private readonly activeExports = new Set<symbol>();

  acquire(tenantId: string): (() => void) | undefined {
    if (this.activeTenants.has(tenantId)) return undefined;
    if (this.activeExports.size >= MAX_EXPORTS_PER_PROCESS) return undefined;

    const token = Symbol(tenantId);
    this.activeTenants.set(tenantId, token);
    this.activeExports.add(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.activeTenants.get(tenantId) === token)
        this.activeTenants.delete(tenantId);
      this.activeExports.delete(token);
    };
  }
}

export const exportSlots = new ExportSlots();
