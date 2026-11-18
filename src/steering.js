// One steering update at a time, resolved only when its successor is created.
// Acceptance alone means the gateway has retained the update, not applied it.
export class SteeringState {
  constructor(error) {
    this.error = error;
    this.responseId = null;
    this.pending = null;
    this.terminal = null;
  }

  begin(input, send) {
    if (!this.responseId) throw this.error('The response is still starting. Try steering again in a moment.');
    if (this.pending) throw this.error('The previous steering update is still being applied.');
    return new Promise((resolve, reject) => {
      this.pending = { parent: this.responseId, id: null, resolve, reject };
      try { send({ type: 'response.steer', previous_response_id: this.responseId, input }); }
      catch (error) { this.reject(error); }
    });
  }

  reject(error) {
    this.pending?.reject(error);
    this.pending = null;
  }

  // Return a deferred parent terminal when a rejected update leaves that answer valid.
  event(event) {
    if (event.type === 'response.created') {
      const response = event.response;
      if (this.pending && response.id !== this.pending.parent) {
        if (!this.pending.id || response.previous_response_id !== this.pending.parent) {
          throw this.error('The gateway created an unexpected steering successor.');
        }
        this.pending.resolve({ steerId: this.pending.id, responseId: response.id });
        this.pending = null;
        this.terminal = null;
      }
      this.responseId = response.id;
    }
    if (event.type.startsWith('response.steer.')) {
      const pending = this.pending;
      if (!pending || event.steer?.previous_response_id !== pending.parent) return null;
      if (event.type === 'response.steer.accepted') {
        if (typeof event.steer.id !== 'string') throw this.error('Invalid steering acknowledgement.');
        pending.id = event.steer.id;
      } else if (event.type === 'response.steer.pending') {
        throw this.error('Steering cannot continue across a local tool handoff. Start a new request with your update.');
      } else if (event.type === 'response.steer.failed') {
        if (pending.id && event.steer.id !== pending.id) return null;
        this.reject(this.error('The gateway could not apply that steering update. Please send it as a new request.', event.error?.code));
        const terminal = this.terminal;
        this.terminal = null;
        return terminal;
      }
    }
    return null;
  }

  deferTerminal(event) {
    if (!this.pending || event.response?.id !== this.pending.parent) return false;
    // A natural completion can beat steering; keep listening for its control outcome.
    if (event.type === 'response.completed' || (event.type === 'response.incomplete' && event.response?.incomplete_details?.reason === 'steered')) {
      this.terminal = event;
      return true;
    }
    return false;
  }
}
