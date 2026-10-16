# Craftpick Status

Système de monitoring et page de status publique, inspiré d'Uptime Kuma. **Aucune dépendance** : seulement Node.js 18+.

![CI](https://github.com/louisoff84/trucstatus/actions/workflows/ci.yml/badge.svg)

## Démarrage

```bash
npm start
```

- Page publique : http://localhost:3001/
- Administration : http://localhost:3001/admin (au premier lancement, tu crées le mot de passe admin)

### Avec Docker

```bash
docker compose up -d --build
```

Les données sont stockées dans `./data`, monté comme volume.

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3001` | Port HTTP |
| `HOST` | `0.0.0.0` | Interface d'écoute |
| `DATA_DIR` | `./data` | Dossier de la base JSON |
| `TRUST_PROXY` | `0` | `1` derrière Nginx/Caddy/Traefik : utilise `X-Forwarded-For` (anti-bruteforce) et `X-Forwarded-Proto` (cookie `Secure`) |

## Fonctionnalités

**Surveillance**
- HTTP(S) : méthode, en-têtes, corps, auth basique, codes acceptés (`200-299,301`)
- HTTP(S) avec mot-clé (présent ou absent, sensible ou non à la casse)
- HTTP(S) avec vérification d'une valeur JSON (`data.status = ok`)
- Port TCP, ping ICMP (Windows et Linux), DNS (A, AAAA, MX, TXT…, serveur personnalisé)
- **Push / heartbeat** : ton script ou ton cron appelle une URL ; s'il ne le fait plus dans le délai prévu, le monitor passe hors ligne
- **Serveur Minecraft** (Java et Bedrock) : joueurs connectés, version, MOTD, courbe de fréquentation ; SRV `_minecraft._tcp` pris en charge
- **Nœud Proxmox VE** via l'API : CPU, RAM, disque, uptime, VM/CT ; panne si une VM surveillée s'arrête, « Dégradé » si un seuil est dépassé
- **Statut « Dégradé »** : le service répond, mais au-delà d'un seuil de temps de réponse (orange, compté comme disponible, notification optionnelle)
- Tentatives avant alerte, intervalle accéléré en cas de panne, **rappels réguliers tant que le service reste en panne**
- Durée de la panne indiquée au retour du service (« de retour après 12 min »)
- Suivi de l'expiration des certificats TLS, avec alerte

**Page publique**
- Bandeau d'état global, groupes de services, barres de disponibilité sur 90 jours
- Incidents et maintenances avec suivi des mises à jour, historique sur `/history`
- Temps réel (SSE), thème auto / clair / sombre
- Flux RSS des incidents : `/api/feed.xml`
- Badges SVG : `/api/badge/<id>`

**Administration**
- Tableau de bord, recherche, graphique des temps de réponse (1 h → 7 j), journal des changements d'état
- Pause, duplication, test d'un monitor avant de l'enregistrer
- Maintenances planifiées : les monitors concernés passent en « Maintenance », sans alerte
- Notifications : Discord, Slack, Telegram, ntfy, Gotify, Pushover, webhook JSON (avec envoi de test)
- Alertes du navigateur quand un service change d'état
- Sessions conservées après un redémarrage, export / import de la configuration

## Monitor push

Après avoir créé un monitor de type « Push », l'URL s'affiche dans sa fiche :

```bash
# Linux (cron toutes les minutes)
* * * * * curl -fsS "https://status.exemple.fr/api/push/<token>?status=up&msg=OK" >/dev/null

# Windows (PowerShell, tâche planifiée)
Invoke-WebRequest "https://status.exemple.fr/api/push/<token>" -UseBasicParsing | Out-Null
```

Paramètres optionnels : `status=up|down|degraded`, `msg=…`, `ping=<ms>`. L'URL accepte GET et POST (JSON).

## Monitor Minecraft

Type « Serveur Minecraft » : renseigne l'hôte (ex. `play.craftpick.fr`) et choisis l'édition.

- **Java** : utilise le Server List Ping. Si le port est vide, l'enregistrement SRV `_minecraft._tcp.<hôte>` est utilisé, sinon le port 25565.
- **Bedrock** : ping RakNet en UDP, port 19132 par défaut.

La page publique affiche les joueurs connectés, le MOTD et une courbe sur 24 h. L'admin peut basculer le graphique entre ping et joueurs.

## Monitor Proxmox

1. Dans Proxmox : *Datacenter → Permissions → API Tokens → Add*, par exemple l'utilisateur `root@pam` avec l'ID `status`. Décoche « Privilege Separation » ou donne au jeton le rôle **PVEAuditor** sur `/` (lecture seule).
2. Dans Craftpick Status : type « Nœud Proxmox »
   - URL : `https://<ip>:8006`
   - Nœud : `pve`
   - ID du jeton : `root@pam!status`
   - Secret : l'UUID affiché par Proxmox
3. Options :
   - VM/CT à surveiller (ex. `100, 101`) : le monitor passe hors ligne si l'une d'elles est arrêtée.
   - Seuils CPU / RAM / disque : le monitor passe en « Dégradé ».

Le secret du jeton n'est jamais renvoyé au navigateur. « Ignorer les erreurs TLS » est coché par défaut, car Proxmox utilise un certificat auto-signé.

## Pages de status multiples

Menu **Pages** de l'admin : crée par exemple `/s/joueurs` (serveurs de jeu, site, Discord) et `/s/infra` (Proxmox, proxy). Chaque page a :
- son titre, sa description et son logo ;
- sa sélection de services, dans l'ordre de ton choix ;
- un **mot de passe** optionnel, avec un cookie valable 30 jours. Changer le mot de passe déconnecte tout le monde.

La page principale `/` continue d'afficher les monitors marqués « publics ». Un monitor privé peut apparaître sur une page dédiée protégée.

## API publique

| Route | Description |
|---|---|
| `GET /api/status` | État des services publics et incidents (`?page=<slug>` pour une page dédiée) |
| `GET /api/health` | Santé du serveur (Docker, autre outil de monitoring) |
| `GET /api/feed.xml` | Flux RSS des incidents |
| `GET /api/badge/<id>` | Badge SVG |
| `GET/POST /api/push/<token>` | Réception d'un heartbeat |

## Données

Tout est dans `data/db.json` : battements bruts sur 7 jours, agrégats journaliers sur 90 jours. Pour sauvegarder, copie ce fichier. ⚠️ Il contient le hash du mot de passe admin et les sessions : **ne le commite pas** (il est dans `.gitignore`).

## Tests

```bash
npm test
```

## Lancer en tâche de fond sans Docker

```bash
npm i -g pm2
pm2 start server.js --name craftpick-status
pm2 save
```

Derrière un reverse proxy, désactive la mise en tampon pour `/api/events` (SSE), par exemple `proxy_buffering off;` avec Nginx.
