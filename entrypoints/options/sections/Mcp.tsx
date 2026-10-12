// AI apps (MCP): let an AI app on this computer (Claude Code, Claude Desktop,
// Codex...) drive the browser through tabi-mcp. On/off with the connection
// status, the pairing token (pasted here, never shown back), and setup steps.
import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { BridgeStatus } from '@/lib/mcp/bridgeClient';
import { Card, CodeBlock, Notice, PageHead, TextInput, Toggle, send } from '../ui';

interface McpState { enabled: boolean; hasToken: boolean; status: BridgeStatus; detail?: string }

const STATUS: Record<BridgeStatus, { text: string; tone: string; dot: string }> = {
  off: { text: 'Off', tone: 'text-muted', dot: 'bg-border-strong' },
  waiting: { text: 'On · waiting for tabi-mcp, which starts when your AI app uses Tabi', tone: 'text-muted', dot: 'bg-accent' },
  connected: { text: 'Connected to your AI app', tone: 'text-green', dot: 'bg-green' },
  rejected: { text: 'Not connected', tone: 'text-red', dot: 'bg-red' },
};

export default function Mcp() {
  const [mcp, setMcp] = useState<McpState>({ enabled: false, hasToken: false, status: 'off' });
  const [token, setToken] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // The status changes while this page is open (an AI app starts tabi-mcp)
    const load = () => send<McpState>('GET_MCP').then((res) => { if (res.success && res.data) setMcp(res.data); });
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, []);

  const save = async (change: { enabled?: boolean; token?: string }) => {
    setError('');
    const res = await send<McpState>('SAVE_MCP', change);
    if (!res.success) return setError(res.error ?? 'Couldn’t save it');
    setMcp(res.data!);
    if (change.token) {
      setToken('');
      setReplacing(false);
    }
  };

  const status = STATUS[mcp.status];
  return (
    <>
      <PageHead title="AI apps (MCP)">Let Claude Code, Claude Desktop, Codex or any MCP app on this computer drive the browser through Tabi. The model runs in that app, on your plan with it. Your safety rules still apply.</PageHead>

      <Card bare testId="mcp">
        <div className="px-5 py-4 flex gap-4 items-start border-b border-border">
          <div className="flex-1">
            <div className="font-semibold text-[14px]">Let AI apps control this browser</div>
            <div className={`flex items-center gap-[6px] text-[12px] mt-1 ${status.tone}`} role="status">
              <span aria-hidden className={`w-[7px] h-[7px] rounded-full ${status.dot}`} />
              {status.text}{mcp.detail ? `: ${mcp.detail}` : ''}
            </div>
          </div>
          <Toggle on={mcp.enabled} onChange={(on) => save({ enabled: on })} label="Let AI apps control this browser" />
        </div>
        <div className="px-5 py-4 flex flex-col gap-[6px] border-b border-border">
          <span className="text-[12px] font-medium">Pairing token</span>
          {mcp.hasToken && !replacing ? (
            <div className="flex gap-[6px] flex-wrap">
              <span className="flex-1 max-w-[420px] h-[34px] flex items-center gap-2 px-[10px] rounded-ctl border border-border-strong bg-raised font-mono text-[12px] text-muted">
                <KeyRound size={13} aria-hidden />tbk_•••• saved on this device
              </span>
              <button type="button" className="btn btn-secondary h-[34px]" onClick={() => setReplacing(true)}>Paste a new one</button>
            </div>
          ) : (
            <form className="flex gap-[6px] flex-wrap" onSubmit={(e) => { e.preventDefault(); if (token.trim()) save({ token }); }}>
              <TextInput icon={KeyRound} mono type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="tbk_…" aria-label="Pairing token" autoComplete="off" className="flex-1 max-w-[420px]" />
              <button type="submit" className="btn btn-primary h-[34px]" disabled={!token.trim()}>Save</button>
              {replacing && <button type="button" className="btn btn-quiet h-[34px]" onClick={() => { setReplacing(false); setToken(''); }}>Cancel</button>}
            </form>
          )}
          <span className="text-[12px] text-muted">The token proves to Tabi that it’s talking to your tabi-mcp. Making a new one (<code className="font-mono">tabi-mcp new-token</code>) disconnects apps using the old one.</span>
          {error && <Notice kind="error">{error}</Notice>}
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          <span className="font-semibold">Setup, once</span>
          <CodeBlock title="1. Build the helper, in the Tabi folder" code="cd mcp && npm install && npm run build" />
          <CodeBlock title="2. Show the pairing token to paste above, and the command for your AI app" code="node mcp/dist/server.js token" />
          <CodeBlock title="3. Claude Code, for example (use the path it printed)" code={'claude mcp add tabi -- node "/path/to/Tabi/mcp/dist/server.js"'} />
        </div>
      </Card>

      {mcp.enabled && (
        <Notice kind="warn"><b className="font-semibold">A connected AI app can read and act on any page in this browser,</b> including sites you’re signed in to. Only connect apps you trust, and turn this off when you’re not using it. The toolbar icon shows “MCP” while one is connected.</Notice>
      )}
    </>
  );
}
