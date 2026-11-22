// Zolana notes. A note is an id the browser keeps. Its z-address belongs to a key derived here from ZSECRET and the id, so nothing is stored:
// the balance lives in Solana Privacy Rings and the key is rebuilt on every request.
//   addr { id }      -> the note's z-address (deposits go there)
//   bal  { id }      -> what the note holds
//   out  { id, to }  -> pays the note to `to`. The note's key signs the withdrawal; the Zolana relayer gives that key its network fee first.
import { createHmac } from 'crypto'
import bs58 from 'bs58'
import { address, createKeyPairSignerFromPrivateKeyBytes, signTransaction, getBase64EncodedWireTransaction, createTransactionMessage, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, compileTransaction, lamports } from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { LocalKeys, ShieldedKeypair, SigningKey, Wallet, SOL_MINT, buildWithdrawalTransaction, syncWallet, getPrivateTokenBalances, initializePoseidon } from '@heliuslabs/spr'
import { SprClient, SignedTeePolicy } from '@heliuslabs/spr/client'

export const config = { maxDuration: 60 }
const HOST = 'https://mainnet.helius-rpc.com'
const FEE = 2_000_000n       // stays in the note: covers the relayer's top-up and the withdrawal's rent
const GAS = 1_500_000n       // what the note's key needs on its address to sign and pay a withdrawal
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let client = null
async function getClient() {
  if (client) return client
  await initializePoseidon()
  const hk = process.env.HELIUS_KEY
  client = new SprClient({ solanaRpcUrl: `${HOST}/?api-key=${hk}`, indexerUrl: `${HOST}/v1/spr`, proverUrl: `${HOST}/v1/spr`, apiKey: hk, proverTee: SignedTeePolicy.forNetwork('mainnet'),
    fetch: (u, o = {}) => { const h = new Headers(o.headers || {}); if (/helius-rpc\.com/.test(String(u))) h.set('x-api-key', hk); return fetch(u, { ...o, headers: h }) } })
  return client
}
const seedOf = (id) => createHmac('sha256', process.env.ZSECRET).update('zolana:note:' + id).digest()
const noteKey = (id) => ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(new Uint8Array(seedOf(id))))
async function note(id) {
  const c = await getClient(), kp = noteKey(id), keys = LocalKeys.fromKeypair(kp, c.proofService), w = new Wallet({ identity: kp.shieldedAddress() })
  await syncWallet({ client: c, wallet: w, keys })
  const b = getPrivateTokenBalances(w).find((x) => x.mint === SOL_MINT)
  return { c, keys, w, lamports: b ? b.amount : 0n }
}
async function confirm(c, sig, b64) {
  for (let i = 0; i < 40; i++) {
    const s = (await c.solanaRpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send()).value[0]
    if (s?.err) throw new Error('failed on chain: ' + JSON.stringify(s.err, (k, v) => typeof v === 'bigint' ? String(v) : v))
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return
    if (i % 4 === 3) { try { await c.solanaRpc.sendTransaction(b64, { encoding: 'base64', skipPreflight: true }).send() } catch {} }
    await sleep(1200)
  }
  throw new Error('not confirmed in time: ' + sig)
}
async function send(c, signer, tx) {
  const signed = await signTransaction([signer.keyPair], tx), b64 = getBase64EncodedWireTransaction(signed)
  const sig = await c.solanaRpc.sendTransaction(b64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }).send()
  await confirm(c, sig, b64); return sig
}
async function out(id, to) {
  const n = await note(id)
  if (n.lamports <= FEE + 1_000_000n) throw new Error(n.lamports === 0n ? 'This note is empty, or its deposit is not indexed yet. Try again in a minute.' : 'This note holds too little to unshield.')
  const c = n.c, k = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(seedOf(id)))
  const have = BigInt((await c.solanaRpc.getBalance(k.address).send()).value)
  if (have < GAS) {
    const r = await createKeyPairSignerFromPrivateKeyBytes(bs58.decode(process.env.RELAYER_SEED))
    const { value: bh } = await c.solanaRpc.getLatestBlockhash().send()
    const msg = pipe(createTransactionMessage({ version: 'legacy' }), (m) => setTransactionMessageFeePayer(r.address, m), (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: r, destination: k.address, amount: lamports(GAS - have) })], m))
    await send(c, r, compileTransaction(msg))
  }
  const tx = await buildWithdrawalTransaction({ client: c, wallet: n.w, keys: n.keys, feePayer: k.address, recipient: address(to), amount: n.lamports - FEE })
  return { signature: await send(c, k, tx), lamports: String(n.lamports - FEE) }
}
export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store')
  if (req.method !== 'POST') return res.status(405).end()
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {}
  const id = String(b.id || '')
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,44}$/.test(id)) return res.status(400).json({ error: 'bad note id' })
  try {
    if (b.op === 'addr') { await getClient(); return res.json({ z: bs58.encode(noteKey(id).shieldedAddress().toBytes()) }) }
    if (b.op === 'bal') return res.json({ lamports: String((await note(id)).lamports) })
    if (b.op === 'out') { const to = String(b.to || ''); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to)) return res.status(400).json({ error: 'bad address' }); return res.json(await out(id, to)) }
    return res.status(400).json({ error: 'unknown op' })
  } catch (e) { console.log('z', b.op, e?.code || '', String(e?.message || e)); return res.status(500).json({ error: String(e?.message || e).slice(0, 240) }) }
}
