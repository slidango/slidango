// Scripted OpenAI-compatible endpoint for the browser tests.
import { startMockOpenAI, textOf } from '../apps/server/src/llm/mock-openai'

const port = Number(process.argv[2])

await startMockOpenAI((req) => {
  const system = textOf(req.messages[0]?.content)
  if (req.tool_choice) {
    return {
      toolCalls: [
        {
          name: 'set_outline',
          arguments: {
            slides: [
              { title: 'Kaffee im Team', message: 'Warum wir mehr Kaffee brauchen', layout: 'cover' },
              { title: 'Drei Gründe', message: 'Wach, gesellig, lecker', layout: 'default' },
            ],
          },
        },
      ],
    }
  }
  const draft = /Schreibe Folie (\d+) von/.exec(system)
  if (draft?.[1] === '1') return { text: '---\nlayout: cover\n---\n\n# Kaffee im Team\n\n<!-- Begrüßung -->' }
  if (draft) return { text: '# Drei Gründe\n\n- Wach\n- Gesellig\n- Lecker\n\n<!-- Kurz halten -->' }
  if (req.messages.some((m) => m.role === 'tool')) return { text: 'Ich habe Folie 2 auf eine Aussage gekürzt.' }
  return { toolCalls: [{ name: 'replace_slide', arguments: { index: 2, content: '# Ein Grund: Kaffee macht wach' } }] }
}, port)
