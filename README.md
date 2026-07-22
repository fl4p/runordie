# RUN OR DIE — Ragdoll Splitscreen

3D-Jump-and-Run für **2 Spieler an einer Tastatur** (Split-Screen) oder **2–4
Spieler online übers Internet**, Ragdoll-Figuren.
Hindernisse kommen auf euch zu und schieben euch von der Plattform — wer herunterfällt, stirbt.
Der letzte Überlebende gewinnt die Runde.

## Offline spielen

Ein Service Worker (`sw.js`) cacht das Spiel samt CDN-Modulen beim ersten
Besuch — danach läuft es auch **ohne Internet** (z.B. von
https://fl4p.github.io/runordie/ einmal öffnen, fertig). Updates werden
automatisch geladen, sobald wieder Netz da ist.

## Starten

Braucht nur einen statischen Server (ES-Module + CDN-Imports):

```sh
python3 -m http.server 8931
# dann http://localhost:8931 öffnen
```

## 🌐 Online-Modus (2–4 Spieler)

Über den Menü-Button **🌐 ONLINE** spielt man übers Internet zusammen:
**Raum erstellen** zeigt einen 4-stelligen Code + Einladungs-Link
(`?room=CODE`), Freunde treten damit bei; ab 2 Spielern startet der Host.
Slot-Farben: blau, orange, grün, pink. Letzter Überlebender gewinnt.

Dafür läuft der kleine Node-Server aus `server/` (statische Dateien +
WebSocket-Relay, keine Spiellogik):

```sh
cd server && npm install && npm start   # http://localhost:8080, PORT=… änderbar
# Latenz-Test: LAG=120 npm start  (120 ms künstliche Einweg-Latenz im Relay)
```

Architektur: **Host-autoritativ** — der Browser des Raum-Erstellers simuliert
das komplette Spiel, Clients schicken nur Eingaben und rendern interpolierte
Snapshots (~120 ms Puffer). Wo möglich verbinden sich Host und Clients
zusätzlich **direkt per WebRTC** (unzuverlässiger DataChannel für Snapshots
und Eingaben = niedrigste Latenz, STUN only); klappt das nicht, läuft alles
automatisch über das WebSocket-Relay. Hindernisse entstehen auf den Clients
per **Spawn-Replay** (der Host schickt die gewürfelten Zufallswerte mit) und
laufen dann lokal butterweich weiter — nur kleine Drift-Korrekturen kommen
über die Snapshots. Wer hostet, sollte die beste Verbindung haben; verlässt
der Host den Raum, endet das Spiel für alle. Statische Kopien (z.B. GitHub
Pages) können per `?server=wss://…` auf ein gehostetes Relay zeigen.

Hinweise: Online sind Rush- und Dreh-Modus deaktiviert; die übrigen
Einstellungen (Hechtsprung, Stun, Eiszonen) bestimmt der Host. Clients sehen
die eigene Figur mit ~Ping-Latenz — die Umgebung bleibt davon unberührt.

## ❄️ Eiszonen

Ab ca. 30 Sekunden zieht regelmäßig eine **Eiszone** auf: Der Schneefall setzt
langsam ein, dann friert die Fahrbahn sichtbar zu und wird **spiegelglatt** —
bei Volleis rutscht die Figur fast ungebremst weiter, an den Kanten wird es
richtig gefährlich. Nach ~20 Sekunden taut die Bahn allmählich wieder auf.
Über den **❄️-Knopf im Hauptmenü** lassen sich Eiszonen komplett abschalten
(wird im Browser gespeichert).

## Spielmodi

Im Hauptmenü: **Taste 1** (oder der Button **▶ Einzelspieler starten**) startet
den **Einzelspieler-Modus** (Vollbild, Überlebenszeit zählt, Rekord wird im
Browser gespeichert), jede andere Taste den 2-Spieler-Splitscreen.
**ESC** führt jederzeit zurück ins Menü.

## 📱 Handy / Tablet

Auf Touch-Geräten erscheinen im Spiel automatisch Touch-Controls (steuern
Spieler 1 — ideal für den Einzelspieler-Modus):

- **Virtueller Stick** (links) — laufen, analog in alle Richtungen
- **▲** (rechts) — springen, 2× tippen = Doppelsprung, 3× = Hechtsprung (mit 💎)
- **🥊** — boxen · **🛝** — grätschen
- **✕** (oben rechts) — zurück ins Menü

Gestartet wird über die Buttons im Hauptmenü.

## Steuerung

| | Spieler 1 (blau) | Spieler 2 (orange) |
|---|---|---|
| Bewegen | W A S D | Pfeiltasten |
| Springen | Leertaste | Enter |
| Doppelsprung/Hechtsprung | 2× Leertaste | 2× Enter |

**Hechtsprung** (braucht 💎): Dritter Sprung in der Luft — die Figur kippt nach
vorn und bekommt einen kräftigen Boost in Bewegungs- bzw. Blickrichtung.
Wer **während des Hechtsprungs boxt**, schleudert den Gegner 1,7× härter weg.
Die Landung richtet die Figur wieder auf.

Über den **🤸-Knopf im Hauptmenü** lässt sich das klassische Verhalten
einschalten: Der Hechtsprung ist dann immer als Doppelsprung verfügbar, und
💎-Kristalle geben je **+1 Extra-Hechtsprung** in der Luft (bis zu 3).
Die Wahl wird im Browser gespeichert.
| Boxen | E oder linke Maustaste | − (Minus) |
| Grätsche | rechte Maustaste | . (Punkt) |

**Grätsche** (Controller: **B** — Springen liegt nur noch auf A): Die Figur
rutscht 0,55 s mit 13 m/s in Rücklage nach vorn. Ein erwischter Gegner wird
**nach oben geschleudert und gestunnt** (ein 🛡 blockt). 1,3 s Abklingzeit,
nur am Boden startbar; während des Slides ist keine Steuerung möglich —
Vorsicht an Plattformkanten.

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

## Tag/Nacht

**T** schaltet zwischen Nacht-Skybox (Sterne, Mond) und Tag-Skybox um — einem
Dämmerungshimmel (Schieferblau → Graumauve → warmes Sand) mit tiefstehender
Sonne und Schleierwolken; Licht und Nebel wechseln die Stimmung mit.

## Menü-Optionen

- **🤸 Hechtsprung-Knopf:** klassisches Verhalten (Dive immer als Doppelsprung)
  oder Kristall-Modus (Standard)
- **💫 Hindernis-Stun-Knopf:** schaltet Knockback/Ragdoll-Stun von
  Hindernis-Treffern und Lasern ab — sie schieben dann nur noch physisch.
  **TNT-Explosionen schleudern immer**, und Boxen/Grätsche zwischen Spielern
  bleiben aktiv.
- **⚔️/🏃 Modus-Knopf:** **Duell** (Standard) spielt auf der festen Bahn.
  **Rush** erlaubt das Vorstürmen: Läuft ein Spieler nach vorn, baut sich die
  Straße automatisch segmentweise weiter aus (inkl. Spurlinien, Graffiti,
  Gullis), die Hindernis-/Laser-Spawnlinie wandert mit dem Führenden mit, und
  abgehängte Segmente hinter allen Spielern werden abgebaut. Himmel und Sonne
  reisen mit.
- Alle Optionen sowie Tag/Nacht (T) und Dreh-Modus (R) werden im Browser
  gespeichert.

## Hindernisse

- **Latte** (rot): niedrige Querstange — drüberspringen
- **Wand** (lila Ziegel): Wand mit Lücke — durchlaufen. Manche Wände sind
  **3 Sprünge hoch** (4,2 m): nur mit einer Hechtsprung-Kette (💎) übersteigbar,
  sonst hilft nur die Lücke
- **Schieber** (gelb): pendelt seitlich und drückt euch Richtung Kante
- **Walze** (türkis): schnelle Rolle über die volle Breite — Doppelsprung!

## Kanten-Hängen

Wer über eine Seiten- oder Hinterkante fällt, greift automatisch zu und
**hängt an den Armen** an der Kante. Die **Sprungtaste zieht Stück für Stück
hoch** (~4 Züge), bis sich die Figur über die Lippe stemmt. Ohne Ziehen werden
die Arme nach 3 Sekunden müde; Eingabe von der Kante weg lässt bewusst los.

## Power-ups

Schweben rotierend auf der Bahn und kommen mit den Hindernissen angeflogen —
einfach durchlaufen zum Einsammeln:

- **💎 Hechtsprung-Kristall** (grün): gibt **3 Hechtsprünge**. Der Hechtsprung
  ist der dritte Sprung in der Luft — ein Vorwärts-Dive mit Kipp-Pose und
  kräftigem Boost in Bewegungs-/Blickrichtung. Ohne Kristall gibt es nur den
  normalen Doppelsprung
- **🥊 Schlagkraft-Kristall** (rot): die nächsten **3 treffenden Box-Schläge**
  schleudern 1,8× härter (kombiniert sich mit dem Hechtsprung-Bonus)
- **🐌 Zeitlupe** (violetter Kristall): verpasst dem **Gegner** 4 Sekunden
  Zeitlupe — nur noch 45 % Lauftempo, markiert durch eine violette Blase und
  🐌 in dessen HUD
- **🧲 Magnet** (rotes Hufeisen): zieht 6 Sekunden lang alle Power-ups auf der
  Bahn zum Besitzer (Reichweite 14 m)
- **⭐ Unverwundbarkeit** (goldener Knoten): 5 Sekunden immun gegen
  Hindernis-Stuns, Laser, Explosionen und gegnerische Schläge/Grätschen
  (Herunterfallen bleibt tödlich!) — sichtbar als pulsierende Gold-Aura
- **🛡 Schild** (blauer Ring): gibt **3 Schild-Blocks** — jeder schluckt einen
  Hindernis-/Laser-/Box-Treffer (kein Ragdoll-Stun, nur ein abgeschwächter
  Schubs); sichtbar als Blase, das HUD zeigt die verbleibenden Blocks

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
- **💥 Explodierende Blöcke:** Ein verstreutes Feld aus TNT-Kisten. Berührung
  zündet (0,3 s blinkende Lunte), dann schleudert die Explosion alle Spieler im
  Umkreis als Ragdoll weg — und zündet Nachbarblöcke als **Kettenreaktion**.
  Drüberspringen, durchschlängeln — oder **wegboxen**: Ein Faustschlag schlägt
  eine unscharfe Kiste weg, statt sie zu zünden. Trifft die fliegende Kiste den
  Gegner, zündet die Lunte bei ihm!
- **🏗 Abrissbirne:** Ein Galgen über der ganzen Bahn, an dem eine Stahlkugel
  an der Kette quer über die Straße pendelt — Timing oder die Randspuren
  nutzen. Treffer stunnen wie Hindernisse.
- **🔨 Stampfer:** Zwei versetzte Pressblöcke schweben über je einer
  Bahnhälfte (rote Warnmarkierung am Boden pulsiert) und rammen im Takt
  herunter — wer daruntersteht, wird zerquetscht. Timing: durchlaufen, wenn
  der Block gerade oben ist.
- **🧱💥 TNT-Mauer:** Manchmal kommt eine ganze **Mauer aus TNT-Blöcken**
  (volle Breite, 2–3 Reihen hoch). Eine Berührung sprengt per Kettenreaktion
  ein Loch hinein — wer zu nah steht, fliegt mit. Alternativ per Doppelsprung
  oben drüber.

## Haie 🦈

Ab 15 Sekunden springen alle 9–18 Sekunden **Haie** aus dem Asphalt-Ozean
neben der Bahn: hoher Bogen von der Seite, der Abwärtsast zielt auf einen
zufälligen Spieler. Wer erwischt wird, wird **zerquetscht** (schwerer Stun,
nach unten gedrückt — ⭐/🛡 schützen). Danach taucht der Hai mit einem Splash
wieder in die Straße ab.

## Laser

Ab ca. 8 Sekunden wandern rote **Laserstrahlen** langsam über die Straße.
Berührung zappt: Ragdoll + Schleuder (ein 🛡 blockt). Alle 16 Sekunden kommt
ein weiterer Laser dazu (max. 4 gleichzeitig). Drei Typen:

- **Querstrahl:** volle Breite in Sprunghöhe, manche pendeln auf und ab
- **Rotierend:** ein Propeller-Balken kreist um eine schwebende Nabe —
  Durchlaufen braucht Timing
- **Scheibenwischer:** am Fahrbahnrand verankert, schwenkt auf und ab und
  fegt periodisch über die halbe Bahn

Das Tempo steigt mit der Zeit. Treffer werfen die Figur kurz in den vollen
Ragdoll-Modus (keine Kontrolle) — fällt sie dabei von der Plattform, war's das.

## Bot-Gegner (GEGEN BOT)

Über den Menü-Button **🤖 GEGEN BOT** (oder Taste `2`) spielt man allein im
Vollbild gegen einen Computer-Gegner, der Spieler 2 steuert. Die Stärke
(LEICHT/MITTEL/SCHWER) wird im Menü durchgeschaltet und gemerkt. Der Bot nutzt
dieselbe Eingabe-Pipeline wie ein Mensch (Analog-Pads + `tryJump/tryPunch/
tryTackle`): er weicht Hindernissen, Lasern und Haien aus, hangelt sich an
Kanten hoch, sammelt Power-ups und boxt/grätscht im Nahkampf. Schwierigkeit =
Reaktionszeit, Zielfehler, Aussetzer-Quote und Aggressivität.

### Automatisierte Tests / Soak

- `?bot=easy|medium|hard` — startet sofort GEGEN BOT
- `?bot1=hard&bot2=hard` — zwei Bots spielen endlos gegeneinander (Splitscreen,
  Runden starten von selbst neu) — ideal als Dauerlauf zum Bug-Finden
- `?bot3=…&?bot4=…` — aktiviert zusätzlich die Spieler-Slots 3/4 (grün/pink)
  für einen lokalen 4-Spieler-Soak-Test
- `?check=1` — Invarianten-Checks auch ohne Bot (NaN-Positionen, festhängende
  Ragdolls/Runden, Entity-Leaks, Geschwindigkeits-Explosionen). Verstöße landen
  als `console.error('[INVARIANT]', …)` und in `window.__game.invariants`.
- `__game.setBot(spielerIndex, 'hard' | null)` schaltet Bots zur Laufzeit um.

## Technik

Eine Datei (`index.html`): Three.js (Rendering, Scissor-Splitscreen) + cannon-es
(Physik). Jede Figur besteht aus 10 Physik-Körpern (Torso, Kopf, Arme, Beine) mit
ConeTwist-Gelenken; der Torso wird aktiv aufrecht gehalten (Hover-Feder + Raycast),
die Gliedmaßen baumeln passiv. Bei Treffern/Stürzen wird die Rotationssperre gelöst
→ voller Ragdoll. Debug-Hook für Tests: `window.__game`.
