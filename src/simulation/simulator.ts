// Deterministic simulation of the whole system: the production board, the production
// uploader, and real sync clients, joined by a simulated network and disk, all driven from
// one seed on a virtual clock.
//
// Each run injects the faults the real system meets (the iPad sleeping, the server dying,
// the server dying in the middle of a save) and checks, as it goes and at the end:
//
//   Fidelity     A fetch never returns an image of anything but the current document.
//   Durability   A restart restores exactly the last board written to disk, and no change
//                waits longer than `save_delay_ms_max` to be written.
//   Convergence  Once faults stop, every device and the disk hold the same document.
//   Liveness     Once faults stop, a fetch succeeds.

import type { TLShape } from 'tldraw'
import { drawing_uploader_create, type DrawingUploader } from '../client/drawing_uploader'
import { Board, type ImageResult } from '../server/board'
import { envelope_decode } from '../server/storage'
import { assert } from '../shared/assert'
import { fetch_wait_ms_max, save_delay_ms_max } from '../shared/constants'
import { document_hash, shapes_count, type DocumentRecord } from '../shared/document_hash'
import { Prng } from './prng'
import { SimulatedClient, type Connection } from './simulated_client'
import { SimulatedCrash, SimulatedDisk } from './simulated_disk'
import { globals_install, microtasks_drain, VirtualTime } from './virtual_time'

export type SimulationOptions = { readonly seed: number; readonly steps_count: number }
export type SimulationResult = { readonly trace_hash: string; readonly stats: Stats }

const stats_zero = {
  edits: 0,
  connects: 0,
  disconnects: 0,
  crashes: 0,
  crashes_during_write: 0,
  restarts: 0,
  uploads: 0,
  fetches_image: 0,
  fetches_empty: 0,
  fetches_stale: 0,
}
export type Stats = typeof stats_zero

const steps_count_max = 100_000
const seed_offset_library = 0x4000_0000
const step_ms_max = 600
const latency_ms_max = 40
const render_ms_max = 120
const shapes_pool_count = 24
const settle_ms = 20_000
const events_per_step_count_max = 100_000
const png_signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export async function simulate(options: SimulationOptions): Promise<SimulationResult> {
  assert(options.steps_count > 0, 'steps count is positive')
  assert(options.steps_count <= steps_count_max, 'steps count is bounded')
  // The sync library batches on animation frames, which do not exist here, unless it is told
  // it is under test. `bun test` sets this; `bun run simulate` sets it in its script.
  assert(process.env.NODE_ENV === 'test', 'simulation runs with NODE_ENV=test')

  const prng = new Prng(options.seed)
  const time = new VirtualTime()
  // The library draws random ids from a pool it refills now and then, so how much randomness
  // it consumes depends on what ran earlier in the process. It gets a stream of its own, so
  // that it can never shift the simulator's decisions.
  const globals_restore = globals_install(time, new Prng(options.seed + seed_offset_library))
  try {
    const simulator = new Simulator(prng, time)
    await simulator.run(options.steps_count)
    return simulator.result()
  } finally {
    globals_restore()
  }
}

class Simulator {
  private readonly disk = new SimulatedDisk()
  private readonly clients: SimulatedClient[] = []
  private readonly uploaders: DrawingUploader[] = []
  private readonly stats: Stats = { ...stats_zero }
  private board: Board | null
  private failure: unknown = null
  private trace_hash = 0x811c9dc5
  // The model the board is checked against.
  private durable_hash: string | null = null
  private clock_observed: number
  private unsaved_since_ms: number | null = null

  constructor(private readonly prng: Prng, private readonly time: VirtualTime) {
    this.disk.on_write = (name, bytes) => {
      if (name === 'board.snapshot') this.board_written(bytes)
    }
    this.board = Board.open({ time, disk: this.disk })
    this.clock_observed = this.board.document_state().clock

    this.client_create('ipad', 'draw')
    this.client_create('second-pen', 'draw')
    this.stage_create('mac')
  }

  result(): SimulationResult {
    return { trace_hash: (this.trace_hash >>> 0).toString(16), stats: this.stats }
  }

  async run(steps_count: number): Promise<void> {
    for (let step = 0; step < steps_count; step += 1) {
      this.action_random()
      await this.run_for(this.prng.between(1, step_ms_max))
    }
    await this.settle()
    for (const uploader of this.uploaders) uploader.stop()
    for (const client of this.clients) client.close()
    if (this.board !== null) this.board.destroy()
  }

  // Setup.

  private client_create(name: string, role: 'draw' | 'stage'): SimulatedClient {
    const client = new SimulatedClient(
      name,
      role,
      (sender, message) => this.network_to_server(sender, message),
      (requester) => this.client_restart(requester),
    )
    this.clients.push(client)
    return client
  }

  private stage_create(name: string): void {
    const stage = this.client_create(name, 'stage')
    const uploader = drawing_uploader_create({
      time: this.time,
      records: () => stage.records(),
      render: () => this.render(stage.records()),
      upload: (hash, bytes) => this.upload(hash, bytes),
    })
    stage.store.listen(() => uploader.change_notify(), { scope: 'document' })
    this.uploaders.push(uploader)
  }

  // The fake renderer: an "image" is the PNG signature followed by the hash of what was
  // drawn. That lets a check read back, from the bytes alone, which document an image shows.
  private render(records: readonly DocumentRecord[]): Promise<Uint8Array> {
    const image = new Uint8Array([...png_signature, ...encode(document_hash(records))])
    return new Promise((resolve) => {
      this.time.timeout_set(() => resolve(image), this.prng.between(1, render_ms_max))
    })
  }

  private upload(hash: string, bytes: Uint8Array): Promise<boolean> {
    assert(image_hash(bytes) === hash, 'an upload is labelled with what it shows')
    return new Promise((resolve) => {
      this.time.timeout_set(() => {
        const stored = this.server_run((board) => {
          board.image_put(hash, bytes)
          return true
        })
        if (stored === true) this.stats.uploads += 1
        resolve(stored === true)
      }, this.prng.between(1, latency_ms_max))
    })
  }

  // Time.

  private async run_for(duration_ms: number): Promise<void> {
    const until_ms = this.time.now_ms() + duration_ms
    // Whatever the last action resolved is observed before the world moves on.
    await microtasks_drain()
    if (this.failure !== null) throw this.failure
    for (let events = 0; events <= events_per_step_count_max; events += 1) {
      assert(events < events_per_step_count_max, 'a step runs a bounded number of events')
      let ran = false
      try {
        ran = this.time.run_next(until_ms)
      } catch (error) {
        if (!(error instanceof SimulatedCrash)) throw error
        this.crash(true)
        ran = true
      }
      await microtasks_drain()
      if (this.failure !== null) throw this.failure
      this.observe()
      if (!ran) break
    }
    assert(this.time.now_ms() === until_ms, 'the step ends on time')
  }

  // Runs one call into the server. A simulated crash inside it takes the server down.
  private server_run<T>(run: (board: Board) => T): T | undefined {
    if (this.board === null) return undefined
    try {
      return run(this.board)
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) throw error
      this.crash(true)
      return undefined
    }
  }

  // Network.

  private network_to_server(client: SimulatedClient, message: object): void {
    const connection = client.connection
    if (connection === null) return
    const text = JSON.stringify(message)
    const at_ms = this.delivery_at_ms(connection.to_server_at_ms)
    connection.to_server_at_ms = at_ms
    this.time.timeout_set(() => {
      if (!connection.open) return
      this.trace(`to-server ${client.name}`)
      this.server_run((board) => {
        board.session_message(client.session_id, connection.server_socket, text)
      })
    }, at_ms - this.time.now_ms())
  }

  private network_to_client(client: SimulatedClient, connection: Connection, text: string): void {
    if (!connection.open) return
    const at_ms = this.delivery_at_ms(connection.to_client_at_ms)
    connection.to_client_at_ms = at_ms
    this.time.timeout_set(() => {
      if (!connection.open) return
      this.trace(`to-client ${client.name}`)
      client.socket.message_deliver(JSON.parse(text) as object)
    }, at_ms - this.time.now_ms())
  }

  // A WebSocket delivers in order, so a message never arrives before the one sent before it.
  private delivery_at_ms(previous_at_ms: number): number {
    const at_ms = this.time.now_ms() + this.prng.between(1, latency_ms_max)
    return Math.max(at_ms, previous_at_ms)
  }

  private connect(client: SimulatedClient): void {
    assert(this.board !== null, 'a client connects only to a running server')
    assert(client.connection === null, 'a client has one connection')
    const connection: Connection = {
      open: true,
      to_client_at_ms: 0,
      to_server_at_ms: 0,
      server_socket: {
        readyState: 1,
        send: (data) => this.network_to_client(client, connection, data),
        close: () => this.connection_drop(client, connection),
      },
    }
    client.connection = connection
    const accepted = this.board.session_open(
      client.session_id, client.role, connection.server_socket,
    )
    assert(accepted, 'the simulation stays under the session limit')
    client.socket.status_set('online')
    this.stats.connects += 1
    this.trace(`connect ${client.name}`)
  }

  private connection_drop(client: SimulatedClient, connection: Connection): void {
    if (!connection.open) return
    connection.open = false
    connection.server_socket.readyState = 3
    if (client.connection === connection) {
      client.connection = null
      client.socket.status_set('offline')
    }
  }

  private disconnect(client: SimulatedClient): void {
    const connection = client.connection
    assert(connection !== null, 'only a connected client disconnects')
    this.connection_drop(client, connection)
    this.server_run((board) => board.session_close(client.session_id, connection.server_socket))
    this.stats.disconnects += 1
    this.trace(`disconnect ${client.name}`)
  }

  // The sync client asks for a fresh socket when it stops hearing from the server.
  private client_restart(client: SimulatedClient): void {
    if (client.connection !== null) this.disconnect(client)
    this.time.timeout_set(() => {
      if (this.board !== null && client.connection === null) this.connect(client)
    }, this.prng.between(1, latency_ms_max))
  }

  // Server lifecycle.

  private crash(during_write: boolean): void {
    assert(this.board !== null, 'only a running server crashes')
    const board = this.board
    this.board = null
    board.destroy()
    for (const client of this.clients) {
      if (client.connection !== null) this.connection_drop(client, client.connection)
    }
    this.unsaved_since_ms = null
    this.stats.crashes += 1
    if (during_write) this.stats.crashes_during_write += 1
    this.trace(`crash ${during_write ? 'during write' : 'between events'}`)
  }

  private restart(): void {
    assert(this.board === null, 'only a stopped server restarts')
    this.disk.write_fault_armed = false
    this.board = Board.open({ time: this.time, disk: this.disk })
    const state = this.board.document_state()
    if (this.durable_hash !== null) {
      assert(state.hash === this.durable_hash, 'a restart restores the last board written')
    }
    this.clock_observed = state.clock
    this.stats.restarts += 1
    this.trace(`restart ${state.hash}`)
  }

  // Called by the disk when a board write has landed. The hash is recomputed from the bytes,
  // independently of the board, so the durability check does not trust the code under test.
  private board_written(bytes: Uint8Array): void {
    const decoded = envelope_decode(bytes, 'board')
    assert(decoded.ok, 'a written board decodes')
    const snapshot = JSON.parse(new TextDecoder().decode(decoded.envelope.payload)) as {
      documents: Array<{ state: DocumentRecord }>
    }
    this.durable_hash = document_hash(snapshot.documents.map((document) => document.state))
    this.unsaved_since_ms = null
  }

  private observe(): void {
    if (this.board === null) return
    const clock = this.board.document_state().clock
    if (clock !== this.clock_observed) {
      this.clock_observed = clock
      if (this.unsaved_since_ms === null) this.unsaved_since_ms = this.time.now_ms()
    }
    if (this.unsaved_since_ms !== null) {
      const unsaved_ms = this.time.now_ms() - this.unsaved_since_ms
      assert(unsaved_ms <= save_delay_ms_max, 'no change stays unsaved past the limit')
    }
  }

  // Workload.

  private action_random(): void {
    const roll = this.prng.below(100)
    if (roll < 55) return this.edit()
    if (roll < 65) return this.fetch()
    if (this.board === null) {
      if (roll < 85) this.restart()
      return
    }
    if (roll < 77) return this.connect_random()
    if (roll < 85) return this.disconnect_random()
    if (roll < 87) return this.crash(false)
    if (roll < 89) {
      // The next write to disk will not complete: the server dies in the middle of it.
      this.disk.write_fault_armed = true
    }
  }

  private connect_random(): void {
    const candidates = this.clients.filter((client) => client.connection === null)
    const client = candidates[this.prng.below(candidates.length + 1)]
    if (client !== undefined) this.connect(client)
  }

  private disconnect_random(): void {
    const candidates = this.clients.filter((client) => client.connection !== null)
    const client = candidates[this.prng.below(candidates.length + 1)]
    if (client !== undefined) this.disconnect(client)
  }

  // A device draws, moves, or erases a shape. It may be offline while it does.
  private edit(): void {
    const candidates = this.clients.filter((client) => client.role === 'draw' && client.loaded)
    const client = candidates[this.prng.below(candidates.length + 1)]
    if (client === undefined) return

    const id = `shape:s${this.prng.below(shapes_pool_count)}` as TLShape['id']
    const shape = client.store.get(id)
    if (shape === undefined) {
      client.store.put([shape_create(id, this.prng)])
    } else {
      if (this.prng.chance(0.3)) {
        client.store.remove([id])
      } else {
        client.store.put([{ ...shape, x: this.prng.below(2000), y: this.prng.below(2000) }])
      }
    }
    this.stats.edits += 1
    this.trace(`edit ${client.name} ${id}`)
  }

  private fetch(): void {
    if (this.board === null) return
    this.trace('fetch')
    void this.board.image_get().then((result) => {
      try {
        this.fetch_check(result)
      } catch (error) {
        this.failure = error
      }
    })
  }

  // Fidelity: whatever a fetch returns describes the document as it is at that instant.
  private fetch_check(result: ImageResult): void {
    this.trace(`fetched ${result.kind}`)
    if (result.kind === 'stale') {
      this.stats.fetches_stale += 1
      return
    }
    assert(this.board !== null, 'only a running server answers a fetch')
    const state = this.board.document_state()
    if (result.kind === 'empty') {
      assert(state.shapes_count === 0, 'an empty answer means an empty board')
      this.stats.fetches_empty += 1
    } else {
      assert(state.shapes_count > 0, 'an image answer means a drawing exists')
      assert(image_hash(result.bytes) === state.hash, 'the image shows the current document')
      this.stats.fetches_image += 1
    }
  }

  // The end of the run.

  private async settle(): Promise<void> {
    this.disk.write_fault_armed = false
    if (this.board === null) this.restart()
    for (const client of this.clients) {
      if (client.connection === null) this.connect(client)
    }
    await this.run_for(settle_ms)
    assert(this.board !== null, 'the server stays up once faults stop')

    const state = this.board.document_state()
    for (const client of this.clients) {
      assert(client.loaded, `${client.name} loaded the document`)
      const records = client.records()
      assert(document_hash(records) === state.hash, `${client.name} converged with the server`)
      assert(shapes_count(records) === state.shapes_count, `${client.name} has the same shapes`)
    }
    assert(this.unsaved_since_ms === null, 'everything is saved once changes stop')
    assert(this.durable_hash === null || this.durable_hash === state.hash, 'disk converged')

    let result: ImageResult | null = null
    void this.board.image_get().then((settled) => {
      result = settled
    })
    await this.run_for(fetch_wait_ms_max + 1)
    const fetched = result as ImageResult | null
    assert(fetched !== null, 'a fetch settles within its wait')
    assert(fetched.kind !== 'stale', 'a fetch succeeds once faults stop')
    this.fetch_check(fetched)
  }

  private trace(event: string): void {
    const line = `${this.time.now_ms()} ${event}\n`
    // Set TRACE to print the run: the first place two traces differ is where to look.
    if (process.env.TRACE !== undefined) process.stdout.write(line)
    for (let index = 0; index < line.length; index += 1) {
      this.trace_hash = Math.imul(this.trace_hash ^ line.charCodeAt(index), 16777619)
    }
  }
}

function encode(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

function image_hash(bytes: Uint8Array): string {
  assert(png_signature.every((byte, index) => bytes[index] === byte), 'image is a PNG')
  return new TextDecoder().decode(bytes.subarray(png_signature.length))
}

function shape_create(id: TLShape['id'], prng: Prng): TLShape {
  return {
    id,
    typeName: 'shape',
    type: 'geo',
    x: prng.below(2000),
    y: prng.below(2000),
    rotation: 0,
    index: 'a1',
    // The fixed first page of a fresh board. See `snapshot_empty` in the board.
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 100, h: 100, geo: 'rectangle', color: 'black', labelColor: 'black', fill: 'none',
      dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle',
      growY: 0, url: '', scale: 1, richText: { type: 'doc', content: [] },
    },
  } as unknown as TLShape
}
