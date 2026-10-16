# Craftpick Status

Système de monitoring et page de status publique, inspiré d'Uptime Kuma. **Aucune dépendance** : seulement Node.js 18+.

## Démarrage

```bash
npm start
```

- Page publique : http://localhost:3001/
- Administration : http://localhost:3001/admin (au premier lancement, tu crées le mot de passe admin)

Variables d'environnement : `PORT` (3001 par défaut), `HOST`, `DATA_DIR` (dossier `data/` par défaut).

## Fonctionnalités

**Surveillance**
- HTTP(S) avec méthode, en-têtes, corps et codes acceptés (`200-299,301`)
- HTTP(S) avec mot-clé (présent ou absent, sensible ou non à la casse)
- HTTP(S) avec vérification d'une valeur JSON (`data.status = ok`)
- Port TCP, ping ICMP (Windows et Linux), DNS (A, AAAA, MX, TXT…, serveur personnalisé)
- Intervalle réglable, nombre de tentatives avant alerte, intervalle accéléré en cas de panne
- Suivi de l'expiration des certificats TLS, avec alerte

**Page publique**
- Bandeau d'état global, regroupement des services, barres de disponibilité sur 90 jours avec infobulles
- Incidents et maintenances avec suivi des mises à jour, historique sur `/history`
- Mise à jour en temps réel (SSE), thème clair/sombre automatique
- Badges SVG : `/api/badge/<id>`

**Administration**
- Tableau de bord, liste des monitors avec recherche, détail avec graphique des temps de réponse (1 h → 7 j)
- Pause, duplication, test d'un monitor avant de l'enregistrer
- Incidents et maintenances planifiées : pendant la fenêtre, les monitors concernés passent en « Maintenance », sans alerte
- Notifications : Discord, Slack, Telegram, ntfy, webhook JSON, avec envoi de test
- Export / import de la configuration, changement du mot de passe

## Données

Tout est enregistré dans `data/db.json` : battements bruts sur 7 jours, agrégats journaliers sur 90 jours. Pour sauvegarder, il suffit de copier ce fichier.

## Lancer en tâche de fond

```bash
npm i -g pm2
pm2 start server.js --name craftpick-status
pm2 save
```

Derrière un reverse proxy (Nginx, Caddy), désactive la mise en tampon pour `/api/events` (SSE).
