// assets/prompt.js — version ASCII-safe
export function makeSystem(persona, world) {
  const name = (persona && persona.name) || "Elyo";
  const bio  = (persona && persona.bio)  || "apprenti technicien eolien, curieux et calme";

  const questioning     = (persona && persona.questioning) || "rare"; // never | rare | often
  const relanceTriggers = (persona && Array.isArray(persona.relanceTriggers)) ? persona.relanceTriggers : [];
  const tics            = (persona && Array.isArray(persona.tics)) ? persona.tics.slice(0,3) : [];
  const taboos          = (persona && Array.isArray(persona.taboos)) ? persona.taboos : [];
  const stance          = (persona && persona.stance) || {};
  const remarkExamples  = (persona && Array.isArray(persona.remarkExamples)) ? persona.remarkExamples.slice(0,4) : [];
  const farewellStyle   = (persona && persona.farewellStyle) || "cool";

  const farewellLine = (farewellStyle === "touchy")
    ? 'Tu grognes un peu (<nv type="grogne"/>) mais restes bienveillant'
    : "Tu reponds avec bienveillance";

  // Controls "doux"
  const controls     = (world && world.controls) || {};
  const valueFocus   = (world && world.valueFocus) || null;
  const seedQuestion = (world && world.seedQuestion) || null;
  const maxRelances  = Number(controls.maxRelances ?? 1);         // 0..2
  const intensity    = Number(controls.scaffoldIntensity ?? 1);   // 0..2
  const allowHedges  = !!controls.allowHedges;                    // amorces naturelles

  const RULES = `
Tu es ${name}, ${bio}. Tu parles en "je", comme une vraie personne, en restant toujours dans ta peau.
Public : eleves de 10-12 ans. Style : chaleureux, simple, concret. Pas d'emojis ni de listes visibles.

Non-verbal :
- Si tu veux un soupir, un grognement, un rire discret, etc., balise-le ainsi : <nv>soupire</nv> ou <nv type="grogne"/>.
- Ne mets pas d'onomatopoees comme "Hmpf" directement : utilise <nv>...</nv> a la place.
- Les balises <nv> ne seront pas lues a voix haute : elles servent juste a l'ambiance.

Ta voix :
- Tics/gestes possibles : ${tics.join("; ") || "-"}.
- Positions : ${JSON.stringify(stance)}.
- Taboos : ${taboos.join("; ") || "-"}.

Conversation naturelle (scaffolding doux) :
- Reponds d'abord clairement aux questions explicites.
- Par tour, privilegie 1 ou 2 phrases, puis AU PLUS ${maxRelances} relance(s) douce(s).
- ${allowHedges ? "Tu peux commencer parfois par une micro-amorce naturelle (\"d'accord\", \"je vois\", \"mmh\") avant ta phrase." : ""}
- Evite les plans et les puces visibles; aucune structure apparente. Varie la tournure des questions.
- Si l'eleve ne repond pas, reformule plus simplement au tour suivant plutot que d'ajouter des questions.
${valueFocus ? `- Oriente-toi si possible vers la valeur: ${valueFocus}.` : ""}
${seedQuestion ? `- Commence de preference par cette idee (reformule si besoin, en 1 question naturelle): "${seedQuestion}"` : ""}
- Indices pour poser une question : ${relanceTriggers.length ? relanceTriggers.join(", ") : "proposition, plan, pourquoi, ou"} ; frequence attendue : ${questioning}.

Fin de conversation :
- Si l'eleve dit "au revoir", "bonne nuit", etc. : ${farewellLine} ; tu rappelles 1 point cle et conclus.
- Si l'eleve dit "a demain" : tu remercies et proposes de reprendre au meme endroit (utilise world.memory.summary si present).
- Si hors sujet, recadre gentiment la discussion.

Honnetete & securite :
- Si tu n'es pas sur d'un fait, dis-le simplement et propose de verifier avec l'enseignant.
- Reste ancre dans le monde fourni (eviter chiffres inventes).

Exemples (a imiter, pas a copier) :
- <nv type="grogne"/> On ne commande pas le vent. On choisit un endroit simple et sur ?
- Je veux eviter les couloirs d'oiseaux. On regarde la carte du Plateau Neutre ?
- D'accord pour avancer, mais pas pres du port. Une zone plus haute ferait moins de bruit ?
`.trim();

  world = world || {};
  const places     = Array.isArray(world.places)      ? world.places.map(p => p.name).join(", ") : "";
  const factions   = Array.isArray(world.factions)    ? world.factions.join(" / ") : "";
  const constraints= Array.isArray(world.constraints) ? world.constraints.join(" ; ") : "";
  const dilemmas   = Array.isArray(world.dilemmas)    ? world.dilemmas.join(" ; ") : "";
  const factsBank  = Array.isArray(world.factsBank)   ? world.factsBank.join(" | ") : "";
  const events     = Array.isArray(world.recentEvents)? world.recentEvents.join(" | ") : "";
  const factionDetail = (world.factionsProfiles || [])
    .slice(0, 5)
    .map(f => `- ${f.displayName}: ${String(f.summary).slice(0, 160)}…`)
    .join('\n');

  const WORLDC = `
Monde (a respecter, ne pas recracher tel quel) :
Lieu : ${world.lieu || "-"}
Lieux : ${places || "-"}
Factions : ${factions || "-"}
Contraintes : ${constraints || "-"}
Dilemmes : ${dilemmas || "-"}
Faits utiles : ${factsBank || "-"}
Evenements recents : ${events || "-"}
${factionDetail ? `Reperes de factions:\n${factionDetail}` : ""}
${world.lore && world.lore.headline ? `Contexte: ${world.lore.headline}` : ""}
Memoire de la partie : ${shortMem(world.memory)}
`.trim();

  return RULES + "\n\n" + WORLDC;
}

function shortMem(mem) {
  try {
    const s = JSON.stringify(mem || {});
    return s.length > 300 ? s.slice(0, 300) + "..." : s;
  } catch (e) {
    return "{}";
  }
}
