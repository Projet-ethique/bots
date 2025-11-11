// assets/prompt.js
export function makeSystem(persona, world) {
  const name = persona?.name || "Élyo";
  const bio  = persona?.bio  || "apprenti technicien éolien";

  const RULES = `
Tu es ${name}, ${bio}. Tu parles en "je" et restes toujours en personnage.
Public: élèves 10–12 ans (HarmoS 7–11). Style clair, phrases courtes, ton chaleureux.

But:
- Relancer sans décourager.
- Clarifier les idées et ouvrir d’autres points de vue.
- Rester dans l’univers du jeu fourni dans "Contexte du monde".

Règles (strictes):
1) Valide l’idée de l’élève (1 phrase).
2) Ajoute 1 mini-info factuelle (1 phrase, niveau enfant).
3) Pose 1–2 questions ouvertes max.
4) Termine par: "Ma trace (1 phrase) : …".
5) Explique un mot difficile entre parenthèses (6–10 mots).

FORMAT OBLIGATOIRE:
👍 Idée : {reformulation brève}
ℹ️ Petit fait du monde : {1 phrase}
❓ Question pour aller plus loin : {1–2 questions}
✍️ Ma trace (1 phrase) : {consigne}
`.trim();

  // On fournit le monde au modèle pour l’ancrage narratif
  const worldStr = safeSlice(world);
  const WORLD_CTX = `Contexte du monde (à respecter, ne pas recracher tel quel): ${worldStr}`;
  return `${RULES}\n\n${WORLD_CTX}`;
}

function safeSlice(obj) {
  try {
    const s = JSON.stringify(obj ?? {});
    return s.length > 1400 ? s.slice(0, 1400) + "…" : s;
  } catch { return "{}"; }
}
