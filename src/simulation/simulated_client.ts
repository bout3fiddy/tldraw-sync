// A simulated device: the real sync client and store, attached to a socket whose other end
// is the simulator's network. No browser and no rendering, which is what lets thousands of
// sessions run in a second.

import { TLSyncClient, type TLPersistentClientSocket } from '@tldraw/sync-core'
import { atom, createTLSchema, createTLStore, type TLRecord, type TLStore } from 'tldraw'
import { assert } from '../shared/assert'
import type { Role } from '../shared/constants'
import type { DocumentRecord } from '../shared/document_hash'

type Status = 'online' | 'offline'
type Usable = { ensureStoreIsUsable(): void }
type StatusEvent = { status: Status }
type Listener<T> = (value: T) => void

export class ClientSocket implements TLPersistentClientSocket {
  connectionStatus: Status = 'offline'
  private readonly listeners_message = new Set<Listener<object>>()
  private readonly listeners_status = new Set<Listener<StatusEvent>>()

  constructor(
    private readonly send: (message: object) => void,
    private readonly restart_request: () => void,
  ) {}

  sendMessage(message: object): void {
    this.send(message)
  }

  onReceiveMessage = (listener: Listener<object>): (() => void) => {
    this.listeners_message.add(listener)
    return () => this.listeners_message.delete(listener)
  }

  onStatusChange = (listener: Listener<StatusEvent>): (() => void) => {
    this.listeners_status.add(listener)
    return () => this.listeners_status.delete(listener)
  }

  restart(): void {
    this.restart_request()
  }

  close(): void {}

  status_set(status: Status): void {
    if (this.connectionStatus === status) return
    this.connectionStatus = status
    for (const listener of [...this.listeners_status]) listener({ status })
  }

  message_deliver(message: object): void {
    assert(this.connectionStatus === 'online', 'messages arrive only while online')
    for (const listener of [...this.listeners_message]) listener(message)
  }
}

export type Connection = {
  open: boolean
  // Earliest instants the next message may arrive, which keeps each direction in order.
  to_client_at_ms: number
  to_server_at_ms: number
  readonly server_socket: { readyState: number; send(data: string): void; close(): void }
}

export class SimulatedClient {
  readonly store: TLStore
  readonly socket: ClientSocket
  readonly session_id: string
  connection: Connection | null = null
  loaded = false
  private readonly sync: TLSyncClient<TLRecord, TLStore>

  constructor(
    readonly name: string,
    readonly role: Role,
    send: (client: SimulatedClient, message: object) => void,
    restart_request: (client: SimulatedClient) => void,
  ) {
    this.session_id = `session-${name}`
    this.store = createTLStore({ schema: createTLSchema() })
    this.socket = new ClientSocket(
      (message) => send(this, message),
      () => restart_request(this),
    )
    this.sync = new TLSyncClient<TLRecord, TLStore>({
      store: this.store,
      socket: this.socket,
      presence: atom('presence', null),
      didCancel: () => false,
      onLoad: () => {
        this.loaded = true
      },
      onSyncError: (reason) => {
        throw new Error(`${name}: sync error: ${reason}`)
      },
      // Creates the default page if the server has none yet, as the browser client does.
      onAfterConnect: () => (this.store as unknown as Usable).ensureStoreIsUsable(),
    })
  }

  // The same selection the stage makes in the browser: document records, never presence.
  records(): DocumentRecord[] {
    const types = this.store.scopedTypes.document
    return this.store.allRecords().filter((record) => types.has(record.typeName))
  }

  close(): void {
    this.sync.close()
  }
}
