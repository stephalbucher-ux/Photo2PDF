# PHOTO 2 PDF — Scanner de documents (PWA)

© SA IA — **v4.0**

Numérisez vos documents texte en PDF nets, depuis l'appareil photo ou la galerie. S'installe sur Android comme une vraie application (icône, plein écran, hors-ligne).

**Appli en ligne :** https://stephalbucher-ux.github.io/Photo2PDF/

## Architecture (v4)

1. **Page d'ouverture** : logo PHOTO 2 PDF, copyright SA IA + version, transition automatique (~2 s, le temps de charger le moteur).
2. **Accueil** : logo en haut à gauche + 3 boutons —
   - **SCAN UNIQUE** : une photo → un PDF d'une page.
   - **SCAN LOT** : plusieurs photos à la suite → un seul PDF multipage (file de pages avec miniatures, suppression, tout effacer).
   - **OUVRIR IMAGE** : une photo existante de la galerie (JPG, JPEG, PNG, WebP…) → mêmes possibilités.
3. **Édition** (commune aux 3 modes) :
   - Recadrage : détection automatique des bords + **détourage manuel 4 points** (⛶ Cadre, avec loupe de précision).
   - **Rotation** ⟲ / ⟳ par pas de 90°.
   - Filtres : **Couleur**, **Amélioré** (suppression d'ombres *flat-field* + netteté, par défaut), **Gris**, **N&B** (binarisation par seuillage adaptatif).
   - Réglages qualité : luminosité, contraste, netteté (modes couleur/amélioré/gris) ; finesse et seuil (mode N&B).
4. **Enregistrer** : renommage du fichier, qualité du PDF (Compact / Standard / Haute), **Enregistrer** (téléchargement) ou **Transférer** (menu de partage du téléphone : mail, WhatsApp, Drive…).

## Table des fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Écrans (splash, accueil, édition, enregistrement, détourage) |
| `style.css` | Style (thème sombre « viseur » + teal) |
| `app.js` | Moteur : navigation, détection, détourage, filtres, réglages, export/partage PDF |
| `manifest.webmanifest` | Déclaration PWA |
| `sw.js` | Service worker : cache hors-ligne (`photo2pdf-v4`) |
| `icons/` | Icônes 192 / 512 / maskable / favicon |
| `opencv.js` | OpenCV.js auto-hébergé |

jsPDF est chargé depuis un CDN au premier lancement puis mis en cache.

## Gestion mémoire mobile

Les pages du lot sont stockées **compressées** (JPEG/PNG dataURL), jamais en bitmaps pleine résolution. Tous les canvas intermédiaires et les `cv.Mat` sont libérés immédiatement. La résolution de travail est plafonnée à 2400 px de grand côté.

## Déploiement

Hébergé sur **GitHub Pages** (dépôt `stephalbucher-ux/Photo2PDF`, branche `main`). Chaque commit sur `main` redéploie automatiquement. À chaque mise en ligne, incrémenter `CACHE` dans `sw.js` et `APP_VERSION` dans `app.js` pour forcer la mise à jour chez les utilisateurs (fermer/rouvrir l'appli 2×).

## Test local

```powershell
cd C:\Appli\Photo2PDF
npx serve -l 3000    # ou : python -m http.server 3000
# http://localhost:3000 dans Chrome
```
