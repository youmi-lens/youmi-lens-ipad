// Account + generation + request ordering. A->B->A still invalidates A's old request.
export class BillingRequestIdentity {
  private identity: string | null = null;
  private generation = 0;
  private request = 0;
  setIdentity(identity: string | null) {
    if (this.identity !== identity) { this.identity = identity; this.generation += 1; this.request += 1; }
  }
  begin() { return { identity: this.identity, generation: this.generation, request: ++this.request }; }
  owns(ticket: ReturnType<BillingRequestIdentity['begin']>) {
    return ticket.identity === this.identity && ticket.generation === this.generation && ticket.request === this.request;
  }
}
