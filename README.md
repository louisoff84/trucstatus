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
- **Bases de données** : MySQL/MariaDB (version via le handshake), PostgreSQL (SSLRequest), Redis (AUTH + PING + version) — sans identifiants pour MySQL/PostgreSQL
- **Nœud Proxmox VE** via l'API : CPU, RAM, disque, uptime, VM/CT ; panne si une VM surveillée s'arrête, « Dégradé » si un seuil est dépassé
- **Statut « Dégradé »** : le service répond, mais au-delà d'un seuil de temps de réponse (orange, compté comme disponible, notification optionnelle)
- Tentatives avant alerte, intervalle accéléré en cas de panne, **rappels réguliers tant que le service reste en panne**
- Durée de la panne indiquée au retour du service (« de retour après 12 min »)
- Suivi de l'expiration des certificats TLS, avec alerte
- **Dépendances** : un monitor peut dépendre d'un parent (ex. une VM → le nœud Proxmox). Si le parent est en panne, les alertes des enfants sont masquées

**Page publique**
- Bandeau d'état global, groupes de services, barres de disponibilité sur 90 jours
- Incidents et maintenances avec suivi des mises à jour, historique sur `/history`
- **Page détaillée par service** (`/service/<id>`) : graphique ping / joueurs sur 24 h ou 7 jours, calendrier de disponibilité sur 90 jours, incidents liés
- **Personnalisation** : couleur d'accent, bannière d'annonce (ex. « Event ce soir 21h »), CSS personnalisé
- Temps réel (SSE), thème auto / clair / sombre
- Flux RSS des incidents : `/api/feed.xml`
- Badges SVG : `/api/badge/<id>`

**Administration**
- Tableau de bord, recherche, graphique des temps de réponse (1 h → 7 j), journal des changements d'état
- Pause, duplication, test d'un monitor avant de l'enregistrer
- Maintenances planifiées, ponctuelles ou **récurrentes** (ex. redémarrage chaque nuit de 04:00 à 04:15) : les monitors concernés passent en « Maintenance », sans alerte
- **Message Discord en direct** : un message unique dans ton salon, modifié automatiquement (état, joueurs, incidents)
- **Rapport hebdomadaire** de disponibilité (uptime, pannes, durée, ping, pic de joueurs) envoyé sur tes notifications
- **Widget** à intégrer sur ton site (`/embed`, iframe)
- Notifications : Discord, Slack, Telegram, ntfy, Gotify, Pushover, **email (SMTP)**, webhook JSON (avec envoi de test)
- Alertes du navigateur quand un service change d'état
- Sessions conservées après un redémarrage, export / import de la configuration
- **Multi-utilisateurs** avec rôles (lecteur, éditeur, administrateur) et **journal d'activité**
- **Clés API** pour piloter le status depuis des scripts ou un bot
- **Silence des alertes** d'un monitor (1 h, 4 h, 24 h, 7 j) sans arrêter la surveillance
- **Export CSV** de l'historique d'un monitor (7 jours)
- **Sauvegardes automatiques** quotidiennes de la base (`data/backups/`, 14 conservées, `BACKUP_KEEP` pour changer)

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

## Message Discord en direct

*Paramètres → Message Discord en direct* :
1. Colle l'URL d'un webhook (salon Discord → Paramètres → Intégrations → Webhooks).
2. Choisis la page à afficher.
3. Active l'option.

Le bot publie un message, puis le **modifie** à chaque changement d'état, et toutes les 2 minutes pour les joueurs. Il n'envoie pas de nouveau message à chaque fois. Si le message est supprimé, il en recrée un.

## Widget

```html
<iframe src="https://status.craftpick.fr/embed?page=joueurs&theme=dark" style="width:100%;max-width:420px;height:320px;border:0" loading="lazy"></iframe>
```

Paramètres :
- `page=<slug>` : page à afficher.
- `theme=light|dark` : thème.
- `title=0` : masque l'en-tête.
- `uptime=1` : affiche la disponibilité sur 30 jours.

Le générateur de code se trouve dans *Paramètres*. Les pages protégées par mot de passe ne sont pas affichables en widget.

## Rapport hebdomadaire

*Paramètres → Rapport hebdomadaire* : choisis le jour, l'heure (heure du serveur) et les notifications de destination. Les boutons « Aperçu » et « Envoyer maintenant » permettent de tester.

## API publique

| Route | Description |
|---|---|
| `GET /api/status` | État des services publics et incidents (`?page=<slug>` pour une page dédiée) |
| `GET /api/health` | Santé du serveur (Docker, autre outil de monitoring) |
| `GET /api/feed.xml` | Flux RSS des incidents |
| `GET /api/badge/<id>` | Badge SVG |
| `GET /embed` | Widget HTML intégrable |
| `GET /api/service/<id>` | Détail public d'un service (`?hours=24|168`, `?page=<slug>`) |
| `GET/POST /api/push/<token>` | Réception d'un heartbeat |

## Utilisateurs et rôles

*Admin → Utilisateurs* :

| Rôle | Peut |
|---|---|
| Lecteur | tout consulter, exporter en CSV |
| Éditeur | + créer/modifier/supprimer les monitors, publier les incidents, mettre en silence |
| Administrateur | + paramètres, notifications, pages, utilisateurs, clés API, sauvegardes, journal |

> **Mise à jour depuis une version ≤ 1.4** : ton ancien mot de passe devient le compte **`admin`** (identifiant `admin`, même mot de passe).

Le **journal d'activité** (*Admin → Journal*) garde les 1 000 dernières actions : qui, quoi, quand, et depuis quelle IP. Les échecs de connexion y figurent aussi.

## Clés API

*Admin → Utilisateurs → Clés API* : choisis un nom et un rôle. La clé `cs_…` n'est affichée **qu'une seule fois**.

```bash
# Lire l'état complet
curl -H "Authorization: Bearer cs_xxx" https://status.craftpick.fr/api/monitors

# Publier un incident (rôle éditeur)
curl -X POST -H "Authorization: Bearer cs_xxx" -H "Content-Type: application/json" \
  -d '{"title":"Redémarrage du serveur","severity":"maintenance","status":"inprogress","content":"Retour dans 5 min"}' \
  https://status.craftpick.fr/api/incidents

# Mettre un monitor en silence 1 h
curl -X POST -H "Authorization: Bearer cs_xxx" -H "Content-Type: application/json" -d '{"minutes":60}' \
  https://status.craftpick.fr/api/monitors/12/snooze
```

## Notifications email

Type « Email » dans *Notifications*. Renseigne :
- le serveur SMTP ;
- le port : 587 pour STARTTLS, ou 465 en cochant « TLS implicite » ;
- l'utilisateur et le mot de passe (avec Gmail : un *mot de passe d'application*) ;
- l'expéditeur et les destinataires.

Aucune dépendance : le client SMTP est intégré.

## Restaurer une sauvegarde

Arrête le serveur, remplace `data/db.json` par le fichier voulu de `data/backups/` (téléchargeable aussi depuis *Paramètres → Sauvegarde*), puis relance.

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
