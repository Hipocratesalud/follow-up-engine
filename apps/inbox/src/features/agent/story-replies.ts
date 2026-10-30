import type { AgentLanguage } from '../../api/agent-contract.ts';

/**
 * What María might answer, to play the story quickly: patient content in
 * the conversation's language (not UI copy), the same lines the scripted
 * player understands. The evaluator can always type anything else.
 */
export const STORY_REPLIES: Readonly<Record<AgentLanguage, readonly string[]>> = {
  es: [
    'Hola, sí. Ya me hice el examen la semana pasada, pero el martes no puedo.',
    'La 2 me sirve',
    '¿Cómo salió mi examen?',
    'Por favor no me escriban más',
  ],
  en: [
    "Hi, yes. I already had the test last week, but I can't make it on Tuesday.",
    'Number 2 works for me',
    'How did my test come out?',
    'Please stop texting me',
  ],
};
