# Scanorama — Scanner de documents (PWA)

Photo → PDF net. Recadrage automatique du document + filtres. Sortie en **PDF multipage** ou **un fichier par page**. S'installe sur Android comme une vraie application (icône, plein écran, hors-ligne).

## Nouveautés (v3)

- **Importer** : ouvre une photo existante de la galerie (JPG, JPEG, PNG, WebP…) en plus de la capture caméra.
- **Rotation** : boutons ⟲ / ⟳ sur l'aperçu (90° par appui).
- **Détourage manuel 4 points** : bouton **⛶ Cadre** → déplace les 4 coins sur les bords du document (avec loupe de précision), Valider redresse la perspective. « Auto » relance la détection.
- **Filtre « Amélioré »** (par défaut) : suppression des ombres et du jaunissement (correction *flat-field* : division par le fond estimé), contraste et netteté (*unsharp mask*). Idéal pour un beau rendu de document texte. Le N&B et le Gris profitent aussi de la normalisation d'éclairage.
- **Mémoire mobile corrigée** : les pages ajoutées sont stockées compressées (JPEG/PNG) et plus en bitmaps pleine résolution ; tous les canvas intermédiaires sont libérés. Bouton **Tout effacer** pour vider la file. Cela corrige les blocages à la 2ᵉ utilisation sur téléphone.

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

Le service worker, l'installation PWA et l'accès caméra exigent **HTTPS** (ou `localhost`). Un hébergement type **Vercel** fournit le HTTPS automatiquement — c'est le plus simple, comme pour My Prono Family.

## Déploiement Vercel (recommandé)

```powershell
# Depuis le dossier décompressé
cd .\scanorama
npm i -g vercel      # si pas déjà installé
vercel               # suivre les invites → URL en https://
vercel --prod        # mise en production
```

Puis, sur ton Android : ouvre l'URL dans Chrome → menu ⋮ → **Ajouter à l'écran d'accueil / Installer l'application**.

## Test rapide en local (sur ton PC)

```powershell
cd .\scanorama
npx serve -l 3000    # ou : python -m http.server 3000
# Ouvre http://localhost:3000 dans Chrome (localhost = contexte sécurisé)
```

Pour tester depuis le téléphone, le plus simple reste de déployer sur Vercel et d'ouvrir l'URL https.

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
