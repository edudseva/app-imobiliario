const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config();
const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const client = new Anthropic();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000'
}));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/imoveis', async (req, res) => {
  try {
    const { bairro, tipo, preco_min, preco_max } = req.query;
    let query = 'SELECT * FROM imoveis WHERE status = $1 ORDER BY criado_em DESC';
    let params = ['ativo'];
    let paramCount = 2;
    if (bairro && bairro.trim()) { query += ` AND bairro ILIKE $${paramCount}`; params.push(`%${bairro}%`); paramCount++; }
    if (tipo && tipo.trim()) { query += ` AND tipo = $${paramCount}`; params.push(tipo); paramCount++; }
    if (preco_min) { query += ` AND preco >= $${paramCount}`; params.push(parseFloat(preco_min)); paramCount++; }
    if (preco_max) { query += ` AND preco <= $${paramCount}`; params.push(parseFloat(preco_max)); paramCount++; }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.get('/api/imoveis/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM imoveis WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(result.rows[0]);
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.post('/api/imoveis', async (req, res) => {
  try {
    const { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email } = req.body;
    if (!titulo || !preco || !bairro) return res.status(400).json({ erro: 'Campos obrigatórios: título, preço, bairro' });
    const result = await pool.query(
      `INSERT INTO imoveis (titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [titulo, parseFloat(preco), bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.post('/api/imoveis/:id/analisar', async (req, res) => {
  try {
    const imovelResult = await pool.query('SELECT * FROM imoveis WHERE id = $1', [req.params.id]);
    if (imovelResult.rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    const im = imovelResult.rows[0];
    const prompt = `Você é um especialista em mercado imobiliário brasileiro. Analise este imóvel:
Título: ${im.titulo}
Preço: R$ ${im.preco?.toLocaleString('pt-BR')}
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
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const resposta = JSON.parse(message.content[0].text);
    await pool.query(`INSERT INTO analises_ia (imovel_id, resumo, score, preco_sugestao) VALUES ($1, $2, $3, $4)`,
      [req.params.id, resposta.resumo, resposta.score, resposta.preco_sugestao]);
    res.json(resposta);
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.get('/api/imoveis/:id/analise', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM analises_ia WHERE imovel_id = $1 ORDER BY data_analise DESC LIMIT 1`, [req.params.id]);
    res.json(result.rows[0] || {});
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.delete('/api/imoveis/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM imoveis WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
