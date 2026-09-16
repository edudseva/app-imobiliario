const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config();
const app = express();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
});

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/imoveis', async (req, res) => {
  try {
    const { bairro, tipo, preco_min, preco_max } = req.query;
    let query = 'SELECT * FROM imoveis WHERE status = ? ORDER BY criado_em DESC';
    let params = ['ativo'];
    if (bairro && bairro.trim()) { query += ` AND bairro LIKE ?`; params.push(`%${bairro}%`); }
    if (tipo && tipo.trim()) { query += ` AND tipo = ?`; params.push(tipo); }
    if (preco_min) { query += ` AND preco >= ?`; params.push(parseFloat(preco_min)); }
    if (preco_max) { query += ` AND preco <= ?`; params.push(parseFloat(preco_max)); }
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) { console.error(error); res.status(500).json({ erro: error.message }); }
});

app.get('/api/imoveis/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(rows[0]);
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.post('/api/imoveis', async (req, res) => {
  try {
    const { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email } = req.body;
    if (!titulo || !preco || !bairro) return res.status(400).json({ erro: 'Campos obrigatórios: título, preço, bairro' });
    const [result] = await pool.query(
      `INSERT INTO imoveis (titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [titulo, parseFloat(preco), bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email]
    );
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) { console.error(error); res.status(500).json({ erro: error.message }); }
});

app.post('/api/imoveis/:id/analisar', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    const im = rows[0];
    const prompt = `Você é um especialista em mercado imobiliário brasileiro. Analise este imóvel:
Título: ${im.titulo}
Preço: R$ ${Number(im.preco).toLocaleString('pt-BR')}
Bairro: ${im.bairro}
Tipo: ${im.tipo}
Quartos: ${im.quartos}
Banheiros: ${im.banheiros}
Área: ${im.area_m2}m²
Descrição: ${im.descricao}

Forneça análise em JSON:
{
  "resumo": "Análise breve em 2-3 frases",
  "score": número entre 0 e 100,
  "parecer": "Caro", "Barato", ou "Justo",
  "tempo_venda": "15-30 dias" ou "30-60 dias" ou "60+ dias",
  "preco_sugestao": número ou null,
  "oportunidade": true ou false
}
Responda APENAS com o JSON.`;
    const message = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const textoLimpo = message.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
const resposta = JSON.parse(textoLimpo);
    await pool.query(`INSERT INTO analises_ia (imovel_id, resumo, score, preco_sugestao) VALUES (?, ?, ?, ?)`,
      [req.params.id, resposta.resumo, resposta.score, resposta.preco_sugestao]);
    res.json(resposta);
  } catch (error) { console.error(error); res.status(500).json({ erro: error.message }); }
});

app.get('/api/imoveis/:id/analise', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM analises_ia WHERE imovel_id = ? ORDER BY data_analise DESC LIMIT 1`, [req.params.id]);
    res.json(rows[0] || {});
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.delete('/api/imoveis/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM imoveis WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
