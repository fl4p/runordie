# RUN OR DIE

Lokales 3D-Jump-and-Run für zwei Spieler an einer Tastatur. Beide Spieler
teilen sich eine Arena, sehen das Geschehen aber über zwei eigene Kameras im
Split-Screen.

## Starten

```bash
npm install
npm run dev
```

## Steuerung

- Spieler 1: `W A S D`, Sprung mit `Leertaste`
- Spieler 2: `Pfeiltasten`, Sprung mit `Enter`
- Beide können in der Luft ein zweites Mal springen.

Die Hindernisse werden im Lauf einer Runde schneller. Treffer verursachen
Rückstoß; wer von der Plattform fällt, verliert die Runde.
