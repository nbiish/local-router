// aiRPC canvas — drop-in App.tsx for a `npm create tldraw@latest` scaffold.
// Renders the aiRPC manifest as tldraw blocks with per-block prompt inputs;
// Enter sends the call (repo + block identity + prompt) to the bridge; the
// side panel is the chat feed across repos and queries, with a query bar and
// a Stop button that shuts the bridge down. Built and browser-verified against
// tldraw 5.6.2 (v5 ShapeUtil contract: getGeometry, component, and
// getIndicatorPath returning a Path2D — indicator() is a deprecated stub).
// Re-check the ShapeUtil surface against your scaffold's installed tldraw if
// it drifts.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	Editor,
	HTMLContainer,
	Rectangle2d,
	ShapeUtil,
	Tldraw,
	TLBaseShape,
	createShapeId,
	toRichText,
	useEditor,
} from 'tldraw'
import 'tldraw/tldraw.css'

// Served by the bridge itself -> same origin; a dev scaffold -> bridge default.
const BRIDGE =
	typeof window !== 'undefined' && window.location.port === '7331'
		? window.location.origin
		: 'http://127.0.0.1:7331'

// ---- wire contract (references/protocol.md v1). The loopback bridge is this
// app's own producer, so the named wire types are asserted once at each JSON
// boundary rather than re-guarded at every field read. ----

type WireBlock = {
	id: string
	repo: string
	path: string
	anchor: string
	title: string
	kind: string
	digest: string
	body: string
	lane: number
}
type WireRow = {
	id: string
	kind: string
	seq?: number
	prompt?: string
	reason?: string
	repo?: string
	path?: string
	anchor?: string
	ts?: string
	call_id?: string
	block_id?: string
	status?: string
	summary?: string
	note?: string
}
type WireState = {
	manifest: { blocks: WireBlock[] } | null
	inbox: WireRow[]
	events: WireRow[]
}

// ---- shape ----

type AiRpcBlockProps = {
	w: number
	h: number
	blockId: string
	repo: string
	path: string
	anchor: string
	title: string
	kind: string
	digest: string
	status: string
	summary: string
	note: string
	body: string
}

type AiRpcBlockShape = TLBaseShape<'aiRpcBlock', AiRpcBlockProps>

class AiRpcBlockShapeUtil extends ShapeUtil<AiRpcBlockShape> {
	static override type = 'aiRpcBlock' as const

	getDefaultProps(): AiRpcBlockProps {
		return {
			w: 380,
			h: 220,
			blockId: '',
			repo: '',
			path: '',
			anchor: '',
			title: '',
			kind: 'wiki',
			digest: '',
			status: 'new',
			summary: '',
			note: '',
			body: '',
		}
	}

	override canEdit() {
		return true
	}

	getGeometry(shape: AiRpcBlockShape) {
		return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
	}

	component(shape: AiRpcBlockShape) {
		return (
			<HTMLContainer style={{ pointerEvents: 'all' }}>
				<AiRpcCard shape={shape} />
			</HTMLContainer>
		)
	}

	getIndicatorPath(shape: AiRpcBlockShape): Path2D {
		// tldraw v5 indicator API: a Path2D, not JSX (indicator() is a deprecated stub)
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}
}

function AiRpcCard({ shape }: { shape: AiRpcBlockShape }) {
	const editor = useEditor()
	const { blockId, repo, path, anchor, title, kind, digest, status, summary, note, body } = shape.props
	const [text, setText] = useState('')
	const busy = useRef(false)

	async function send() {
		const prompt = text.trim()
		if (!prompt || busy.current) return
		busy.current = true
		setText('')
		editor.updateShape<AiRpcBlockShape>({
			id: shape.id,
			type: 'aiRpcBlock',
			props: { status: 'sent', summary: 'waiting for agent…' },
		})
		try {
			const res = await fetch(`${BRIDGE}/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					v: 1,
					kind: 'call',
					block_id: blockId,
					repo,
					path,
					anchor,
					digest,
					prompt,
				}),
			})
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
		} catch (e) {
			editor.updateShape<AiRpcBlockShape>({
				id: shape.id,
				type: 'aiRpcBlock',
				props: { status: 'refused', summary: `call failed: ${String(e)}` },
			})
		} finally {
			busy.current = false
		}
	}

	return (
		<div
			style={{
				width: '100%',
				height: '100%',
				background: '#ffffff',
				border: '1px solid #e1e5e9',
				borderRadius: 8,
				padding: 10,
				display: 'flex',
				flexDirection: 'column',
				gap: 6,
				fontFamily: 'ui-sans-serif, system-ui',
				overflow: 'hidden',
			}}
		>
			<div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
				<b style={{ fontSize: 13 }}>{title || path}</b>
				<span
					style={{
						fontSize: 10,
						padding: '2px 6px',
						borderRadius: 999,
						background:
							status === 'done' ? '#d1fae5' : status === 'refused' || status === 'stale' ? '#fee2e2' : '#e0e7ff',
						whiteSpace: 'nowrap',
					}}
				>
					{repo} · {kind} · {status}
				</span>
			</div>
			<div style={{ fontSize: 10, color: '#64748b' }}>
				{path}
				{anchor ? ` › ${anchor}` : ''} · {digest}
			</div>
			{summary ? <div style={{ fontSize: 11 }}>{summary}</div> : null}
			{note ? <div style={{ fontSize: 11, color: '#475569', fontStyle: 'italic' }}>{note}</div> : null}
			<pre
				style={{
					flex: 1,
					margin: 0,
					fontSize: 10,
					overflow: 'auto',
					whiteSpace: 'pre-wrap',
					background: '#f8fafc',
					borderRadius: 4,
					padding: 6,
				}}
			>
				{body.slice(0, 1200)}
			</pre>
			<textarea
				value={text}
				placeholder="Describe the edit… (Enter sends, Shift+Enter newline)"
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault()
						void send()
					}
				}}
				style={{ resize: 'none', height: 40, fontSize: 11, borderRadius: 4, padding: 4 }}
			/>
		</div>
	)
}

function layout(editor: Editor, blocks: WireBlock[]) {
	for (const s of editor.getCurrentPageShapes()) {
		if (s.type === 'aiRpcBlock') editor.deleteShape(s.id)
	}
	const laneY = new Map<number, number>()
	for (const b of blocks) {
		const lane = b.lane ?? 0
		const y = laneY.get(lane) ?? 0
		laneY.set(lane, y + 240)
		editor.createShape<AiRpcBlockShape>({
			id: createShapeId(b.id),
			type: 'aiRpcBlock',
			x: lane * 440,
			y,
			props: {
				w: 380,
				h: 220,
				blockId: b.id,
				repo: b.repo,
				path: b.path,
				anchor: b.anchor,
				title: b.title,
				kind: b.kind,
				digest: b.digest,
				status: 'new',
				summary: '',
				note: '',
				body: b.body,
			},
		})
	}
}

type FeedItem = {
	id: string
	kind: string
	prompt: string
	repo: string
	path: string
	anchor: string
	ts: string
	ack?: { status: string; summary: string; note: string }
}

export default function App() {
	const editorRef = useRef<Editor | null>(null)
	const seqRef = useRef(0)
	const [feed, setFeed] = useState<FeedItem[]>([])
	const [query, setQuery] = useState('')
	const [serverUp, setServerUp] = useState(true)

	const applyState = useCallback((state: WireState) => {
		if (state.manifest && editorRef.current) {
			layout(editorRef.current, state.manifest.blocks)
		}
		const acks = new Map<string, { status: string; summary: string; note: string }>()
		for (const ev of state.events) {
			seqRef.current = Math.max(seqRef.current, ev.seq ?? 0)
			if (ev.kind === 'ack' && ev.call_id) {
				acks.set(ev.call_id, { status: ev.status ?? '', summary: ev.summary ?? '', note: ev.note ?? '' })
			}
		}
		const items: FeedItem[] = []
		for (const row of state.inbox) {
			if (row.kind !== 'call' && row.kind !== 'query' && row.kind !== 'end') continue
			items.push({
				id: row.id,
				kind: row.kind,
				prompt: (row.kind === 'end' ? row.reason : row.prompt) ?? '',
				repo: row.repo ?? '',
				path: row.path ?? '',
				anchor: row.anchor ?? '',
				ts: row.ts ?? '',
				ack: acks.get(row.id),
			})
		}
		setFeed(items.reverse())
	}, [])

	useEffect(() => {
		let alive = true
		async function boot() {
			try {
				const res = await fetch(`${BRIDGE}/state`)
				applyState((await res.json()) as WireState)
				setServerUp(true)
			} catch {
				setServerUp(false)
			}
		}
		async function events() {
			while (alive) {
				let rows: WireRow[] | null = null
				try {
					const res = await fetch(`${BRIDGE}/events?after=${seqRef.current}`)
					if (res.ok) rows = (await res.json()) as WireRow[]
					setServerUp(true)
				} catch {
					setServerUp(false)
				}
				for (const row of rows ?? []) {
					seqRef.current = Math.max(seqRef.current, row.seq ?? 0)
					if (row.kind === 'ack' && row.call_id) {
						const ack = { status: row.status ?? '', summary: row.summary ?? '', note: row.note ?? '' }
						setFeed((f) => f.map((it) => (it.id === row.call_id ? { ...it, ack } : it)))
						if (row.block_id && editorRef.current) {
							const shapeId = createShapeId(row.block_id)
							const shape = editorRef.current.getShape<AiRpcBlockShape>(shapeId)
							if (shape) {
								editorRef.current.updateShape<AiRpcBlockShape>({
									id: shapeId,
									type: 'aiRpcBlock',
									props: { status: ack.status, summary: ack.summary, note: ack.note },
								})
							}
						}
					} else if (row.kind === 'project') {
						void boot()
					}
				}
				const { promise, resolve } = Promise.withResolvers<void>()
				setTimeout(resolve, 900)
				await promise
			}
		}
		void boot()
		void events()
		return () => {
			alive = false
		}
	}, [applyState])

	async function sendQuery() {
		const prompt = query.trim()
		if (!prompt) return
		setQuery('')
		try {
			await fetch(`${BRIDGE}/rpc`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					v: 1,
					kind: 'query',
					anchor: prompt.slice(0, 60),
					prompt,
					path: '',
					block_id: '',
					digest: '',
				}),
			})
		} catch {
			setServerUp(false)
		}
	}

	async function stopServer() {
		try {
			await fetch(`${BRIDGE}/shutdown`, { method: 'POST' })
		} catch {
			/* already gone */
		}
		setServerUp(false)
	}

	return (
		<div style={{ position: 'fixed', inset: 0 }}>
			<Tldraw
				shapeUtils={[AiRpcBlockShapeUtil]}
				onMount={(editor) => {
					editorRef.current = editor
					editor.createShape({
						type: 'text',
						x: 0,
						y: -300,
						props: {
							richText: toRichText(
								'aiRPC — type into a block, Enter sends the call; the panel chats across repos and queries',
							),
						},
					})
					void fetch(`${BRIDGE}/state`)
						.then((r) => r.json())
						.then((state: WireState) => applyState(state))
						.catch(() => setServerUp(false))
				}}
			/>
			<div
				style={{
					position: 'absolute',
					top: 8,
					right: 8,
					bottom: 8,
					width: 320,
					background: '#ffffffee',
					border: '1px solid #e1e5e9',
					borderRadius: 8,
					padding: 10,
					display: 'flex',
					flexDirection: 'column',
					gap: 8,
					fontFamily: 'ui-sans-serif, system-ui',
					zIndex: 1000,
				}}
			>
				<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
					<b style={{ fontSize: 13 }}>aiRPC chat</b>
					<button onClick={() => void stopServer()} style={{ fontSize: 10 }}>
						Stop server
					</button>
				</div>
				<div style={{ fontSize: 10, color: serverUp ? '#16a34a' : '#dc2626' }}>
					{serverUp ? 'bridge up' : 'bridge stopped'}
				</div>
				<textarea
					value={query}
					placeholder="Ask across repos and queries… (Enter sends)"
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault()
							void sendQuery()
						}
					}}
					style={{ resize: 'none', height: 48, fontSize: 11, borderRadius: 4, padding: 6 }}
				/>
				<div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
					{feed.map((it) => (
						<div key={it.id} style={{ border: '1px solid #eef2f7', borderRadius: 6, padding: 6, fontSize: 11 }}>
							<div style={{ fontSize: 9, color: '#64748b' }}>
								{it.kind}
								{it.repo ? ` · ${it.repo}` : ''}
								{it.path ? ` · ${it.path}${it.anchor ? ` › ${it.anchor}` : ''}` : ''}
							</div>
							<div>{it.prompt}</div>
							{it.ack ? (
								<div style={{ marginTop: 4, paddingLeft: 6, borderLeft: '2px solid #c7d2fe' }}>
									<b>{it.ack.status}</b> — {it.ack.summary}
									{it.ack.note ? <div style={{ fontStyle: 'italic', color: '#475569' }}>{it.ack.note}</div> : null}
								</div>
							) : (
								<div style={{ marginTop: 4, color: '#94a3b8' }}>waiting…</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	)
}
