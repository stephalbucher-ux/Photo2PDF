# Scanorama — Scanner de documents (PWA)

Photo → PDF net. Recadrage automatique du document + filtre **noir & blanc par seuillage adaptatif** (`cv.adaptiveThreshold`). Sortie en **PDF multipage** ou **un fichier par page**. S'installe sur Android comme une vraie application (icône, plein écran, hors-ligne).

## Table des fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page unique de l'appli (structure) |
| `style.css` | Style (thème sombre « viseur » + barre de scan teal) |
| `app.js` | Moteur : détection auto, recadrage perspective, seuillage adaptatif, file de pages, export PDF |
| `manifest.webmanifest` | Déclaration PWA (nom, icônes, mode plein écran) |
| `sw.js` | Service worker : cache l'appli + les librairies pour le hors-ligne |
| `icons/` | Icônes 192 / 512 / maskable / favicon |

Les librairies **OpenCV.js** et **jsPDF** sont chargées depuis un CDN au premier lancement, puis mises en cache par le service worker pour fonctionner ensuite hors-ligne.

## Important : contexte sécurisé (HTTPS)

Le service worker, l'installation PWA et l'accès caméra exigent **HTTPS** (ou `localhost`). L'hébergement **GitHub Pages** fournit le HTTPS automatiquement.

## Utilisation en ligne

Ouvre https://stephalbucher-ux.github.io/Photo2PDF/ dans Chrome → menu ⋮ → **Ajouter à l'écran d'accueil / Installer l'application**.

## Test rapide en local (sur ton PC)

```powershell
cd .\scanorama
npx serve -l 3000    # ou : python -m http.server 3000
# Ouvre http://localhost:3000 dans Chrome (localhost = contexte sécurisé)
```

## Comment ça marche

1. **Capturer** ouvre l'appareil photo (ou la galerie). La photo est redressée selon son orientation EXIF.
2. Le moteur cherche le plus grand quadrilatère du document (Canny + contours), corrige la perspective et recadre en pleine résolution.
3. Le filtre s'applique : **Couleur**, **Gris**, ou **N&B** (seuillage adaptatif). Les réglages *Finesse* (taille de bloc) et *Seuil* (constante C) affinent le rendu N&B.
4. **Ajouter** empile la page. **Créer le PDF** assemble tout en un PDF multipage — ou un fichier par page si la case est cochée.

Si les bords ne sont pas détectés (fond peu contrasté), l'appli garde l'image entière et te prévient : pose le document sur une surface de couleur différente.

## Réglage du seuillage adaptatif

Dans `app.js`, fonction `applyFilter`, appel `cv.adaptiveThreshold(gray, dst, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, b, c)` :
- `b` (Finesse) : taille de la fenêtre locale, impair. Petit = plus de détail/bruit ; grand = plus lisse.
- `c` (Seuil) : soustraction ; augmente pour éclaircir le fond, diminue pour renforcer le texte.
