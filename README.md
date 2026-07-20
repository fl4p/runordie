# RUN OR DIE — Ragdoll Splitscreen

3D-Jump-and-Run für **2 Spieler an einer Tastatur**, Split-Screen, Ragdoll-Figuren.
Hindernisse kommen auf euch zu und schieben euch von der Plattform — wer herunterfällt, stirbt.
Der Überlebende gewinnt die Runde.

## Starten

Braucht nur einen statischen Server (ES-Module + CDN-Imports):

```sh
python3 -m http.server 8931
# dann http://localhost:8931 öffnen
```

## Steuerung

| | Spieler 1 (blau) | Spieler 2 (orange) |
|---|---|---|
| Bewegen | W A S D | Pfeiltasten |
| Springen | Leertaste | Enter |
| Doppelsprung | 2× Leertaste | 2× Enter |
| Boxen | E | − (Minus) |

**Boxen:** Kurzer Faustschlag mit ~2 m Reichweite und 0,55 s Abklingzeit.
Trifft er, fliegt der Gegner als Ragdoll davon (ein 🛡 blockt das ab) — perfekt,
um ihn vor ein Hindernis oder von der Plattform zu schubsen. Am Controller: **X**.
Die Figur jabbt dabei abwechselnd mit links und rechts und macht einen kleinen
Ausfallschritt.

**Xbox-Controller** (Gamepad API, Standard-Mapping): Ein neu erkannter
Controller ist zunächst keiner Seite zugeordnet — ein Hinweis erscheint, und
man wählt mit Stick/D-Pad **links** (= Spieler 1) oder **rechts** (= Spieler 2)
seine Seite. Danach: linker Stick (analog) oder D-Pad bewegen, **A**/**B**
springen (2× = Doppelsprung). Pro Seite ist nur ein Pad aktiv (neue Zuordnung
verdrängt die alte); die **Back/View-Taste** gibt das eigene Pad wieder frei,
und ein getrenntes Pad gibt seine Seite automatisch frei.
Tastatur bleibt parallel aktiv. Hinweis: Der Browser meldet einen Controller
erst nach dem ersten Tastendruck auf dem Pad.

## Dreh-Modus (opt-in)

Mit **R** umschaltbar. Die Figuren lassen sich dann frei drehen — Kamera,
Laufrichtung und Box-Richtung folgen dem Blickwinkel:

- **Spieler 1 (WASD):** Maus dreht (Klick ins Spiel aktiviert Pointer-Lock)
- **Controller:** rechter Stick dreht

Geboxt wird in Blickrichtung (der Gegner muss grob vor einem stehen), gelaufen
relativ zur Figur (W = vorwärts in Blickrichtung). Nochmal **R** schaltet zurück;
die Blickwinkel werden dabei zurückgesetzt.

## Hindernisse

- **Latte** (rot): niedrige Querstange — drüberspringen
- **Wand** (lila Ziegel): Wand mit Lücke — durchlaufen. Manche Wände sind
  **3 Sprünge hoch** (4,2 m): nur mit Dreifachsprung (⭐-Power-up) übersteigbar,
  sonst hilft nur die Lücke
- **Schieber** (gelb): pendelt seitlich und drückt euch Richtung Kante
- **Walze** (türkis): schnelle Rolle über die volle Breite — Doppelsprung!

## Power-ups

Schweben rotierend auf der Bahn und kommen mit den Hindernissen angeflogen —
einfach durchlaufen zum Einsammeln:

- **⭐ Extra-Sprung** (grüner Kristall): +1 Luftsprung, stapelbar bis 3 —
  damit sind Dreifach- bis Fünffachsprünge drin
- **🛡 Schild** (blauer Ring): blockt den nächsten Hindernis-Treffer
  (kein Ragdoll-Stun, nur ein abgeschwächter Schubs); sichtbar als Blase

Die Anzeige oben links in jeder Bildschirmhälfte zeigt den aktuellen Vorrat.
Power-ups verfallen beim Rundenende.

## Wellen-Formationen

Jede 5. Spawn-Welle ist eine Formation:

- **Sprung-Pad + Mega-Wand:** Eine 5,2 m hohe Wand aus **roten Ziegeln** über
  die volle Breite — ohne Hilfe unüberwindbar. 9 m davor läuft ein grün
  pulsierendes **Sprung-Pad** mit: wer beim Vorbeiziehen draufsteht, wird hoch
  genug katapultiert (ein Luftsprung bleibt zum Nachsteuern). Die rote Wand
  stunnt nicht — wer sie verpasst, wird nur geschoben.
- **Tunnel:** Betonröhre mit zwei Durchgängen unten — durchlaufen, oder per
  Doppelsprung aufs Dach und oben drüber. Landungen auf Oberseiten zählen nicht
  als Treffer.

Das Tempo steigt mit der Zeit. Treffer werfen die Figur kurz in den vollen
Ragdoll-Modus (keine Kontrolle) — fällt sie dabei von der Plattform, war's das.

## Technik

Eine Datei (`index.html`): Three.js (Rendering, Scissor-Splitscreen) + cannon-es
(Physik). Jede Figur besteht aus 10 Physik-Körpern (Torso, Kopf, Arme, Beine) mit
ConeTwist-Gelenken; der Torso wird aktiv aufrecht gehalten (Hover-Feder + Raycast),
die Gliedmaßen baumeln passiv. Bei Treffern/Stürzen wird die Rotationssperre gelöst
→ voller Ragdoll. Debug-Hook für Tests: `window.__game`.
