// --- Import des modules nécessaires ---
require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// --- Configuration de la base de données ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// --- Initialisation de l'application Express ---
const app = express();
const PORT = process.env.PORT || 3000;

// --- Middlewares ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ROUTES API ---

// Route pour récupérer toutes les données initiales
app.get('/api/initial-data', async (req, res) => {
    try {
        const [clientsRes, prestationsRes, consommablesRes, transactionsRes] = await Promise.all([
            pool.query('SELECT * FROM clients ORDER BY name'),
                                                                                                 pool.query('SELECT p.*, array_agg(pc.consommable_id) as consommables FROM prestations p LEFT JOIN prestation_consommables pc ON p.id = pc.prestation_id GROUP BY p.id ORDER BY p.categorie, p.nom'),
                                                                                                 pool.query('SELECT * FROM consommables ORDER BY nom'),
                                                                                                 pool.query('SELECT t.*, c.name as client_name FROM transactions t JOIN clients c ON t.client_id = c.id ORDER BY t.date DESC')
        ]);

        // On doit reconstruire les détails de chaque transaction
        for (const tx of transactionsRes.rows) {
            const detailsRes = await pool.query('SELECT * FROM transaction_details WHERE transaction_id = $1', [tx.id]);
            tx.prestations = detailsRes.rows.map(d => ({
                id: d.prestation_id,
                nom: d.prestation_nom_custom || prestationsRes.rows.find(p => p.id === d.prestation_id)?.nom,
                                                       tarif: parseFloat(d.montant),
                                                       isPetitPlus: !!d.prestation_nom_custom
            }));
        }

        res.json({
            clients: clientsRes.rows,
            prestations: prestationsRes.rows,
            consommables: consommablesRes.rows,
            transactions: transactionsRes.rows
        });
    } catch (err) {
        console.error('Erreur lors de la récupération des données initiales', err);
        res.status(500).json({ error: err.message });
    }
});

// NOUVEAU: Route pour ajouter un client
app.post('/api/clients', async (req, res) => {
    const { name, contact, notes } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Le nom du client est obligatoire.' });
    }
    try {
        const newClient = await pool.query(
            'INSERT INTO clients (name, contact, notes) VALUES ($1, $2, $3) RETURNING *',
                                           [name, contact, notes]
        );
        res.status(201).json(newClient.rows[0]);
    } catch (err) {
        console.error('Erreur lors de la création du client', err);
        res.status(500).json({ error: err.message });
    }
});

// Route pour enregistrer une nouvelle transaction
app.post('/api/transactions', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { clientId, date, items } = req.body;

        let totalDeclare = 0, totalPetitPlus = 0, totalCharges = 0;

        for (const item of items) {
            if (item.isSpecial) { totalPetitPlus += item.tarif; }
            else { totalDeclare += item.tarif; }
            // Calcul des charges
            const prestationDb = prestationsData.find(p => p.id === item.id);
            if (prestationDb && prestationDb.consommables) {
                prestationDb.consommables.forEach(cId => {
                    const conso = consommablesData.find(c => c.id === cId);
                    if (conso) totalCharges += conso.cout;
                });
            }
        }

        const transactionRes = await client.query(
            'INSERT INTO transactions (client_id, date, montant_declare, montant_petit_plus, charges_variables_calculees) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                                                  [clientId, date, totalDeclare, totalPetitPlus, totalCharges]
        );
        const transactionId = transactionRes.rows[0].id;

        for (const item of items) {
            if (item.isSpecial) {
                await client.query('INSERT INTO transaction_details (transaction_id, prestation_nom_custom, montant) VALUES ($1, $2, $3)', [transactionId, item.nom, item.tarif]);
            } else {
                await client.query('INSERT INTO transaction_details (transaction_id, prestation_id, montant) VALUES ($1, $2, $3)', [transactionId, item.id, item.tarif]);
            }
        }

        await client.query('UPDATE clients SET rdv_count = rdv_count + 1 WHERE id = $1', [clientId]);
        await client.query('COMMIT');
        res.status(201).json({ success: true, transactionId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Erreur lors de la création de la transaction', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// --- Démarrage du serveur ---
app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
