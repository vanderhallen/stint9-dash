/* test-agent-modal.mjs — prove #agentModal gets moved to a direct child of
 * <body>, escaping .wrap's transform so it centres on the real viewport.
 *
 *   node live/test-agent-modal.mjs
 *
 * #agentModal is position:fixed;inset:0 (centres via flex align/justify), but
 * lived inside .agentbar -> .wrap, and fitPage() applies a CSS transform:scale
 * to .wrap whenever the page needs shrinking to fit. Any transformed ancestor
 * becomes the containing block for a fixed descendant, so the modal centred
 * on .wrap's SCALED box instead of the true viewport — reported 2026-09-12 as
 * "not showing in the middle of the page". Same problem, same established fix,
 * as the class/car dropdown popup and the zoom-focus layer: move it to <body>.
 */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

let failures = 0;
const check = (name, cond, got) => { if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  (got ${JSON.stringify(got)})`}`); };

check('the relocation call is present and runs before the modal is wired up',
      html.includes("{const am=document.getElementById('agentModal');if(am)document.body.appendChild(am);}") &&
      html.indexOf("document.body.appendChild(am);") < html.indexOf("document.getElementById('agentModalOk').onclick=closeAgentModal;"),
      'not found, or found after the modal handlers are wired');

/* end to end against a minimal DOM stub: the exact statement, executed, must
   leave #agentModal a direct child of document.body — not of .agentbar. */
{
  const calls = [];
  const agentModal = { id: 'agentModal' };
  const agentbar = { children: [agentModal] };
  const fakeDoc = {
    getElementById: id => id === 'agentModal' ? agentModal : null,
    body: { appendChild: el => { calls.push(el); agentbar.children = agentbar.children.filter(c => c !== el); } },
  };
  new Function('document', "{const am=document.getElementById('agentModal');if(am)document.body.appendChild(am);}")(fakeDoc);
  check('document.body.appendChild is called with the modal element', calls[0] === agentModal, calls);
  check('the modal is no longer a child of .agentbar afterward', !agentbar.children.includes(agentModal), agentbar.children);
}

/* no CSS rule depends on #agentModal being nested inside .agentbar — moving
   it in the DOM tree must not silently drop its styling. */
{
  const scoped = /\.agentbar\s+#agentModal|\.agentbar\s+\.m(box|hd|q|txt|ok)\b/.test(html);
  check('no CSS rule scopes the modal through a .agentbar ancestor selector', !scoped, scoped);
}

console.log(failures ? `\n❌ ${failures} FAILED` : '\n✅ PASS — the agent-answer modal escapes .wrap\'s transform and centres on the real viewport');
process.exit(failures ? 1 : 0);
