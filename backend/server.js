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

function extrairJSON(textoCompleto) {
  const jsonMatch = textoCompleto.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('IA não retornou JSON válido: ' + textoCompleto.slice(0, 300));
  return JSON.parse(jsonMatch[0]);
}

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

app.delete('/api/imoveis/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM imoveis WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

app.post('/api/imoveis/:id/analisar', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    const im = rows[0];

    const resposta = await analisarPreco({
      titulo: im.titulo, preco: im.preco, bairro: im.bairro, tipo: im.tipo,
      quartos: im.quartos, banheiros: im.banheiros, area_m2: im.area_m2, descricao: im.descricao,
    });

    await pool.query(
      `INSERT INTO analises_ia (imovel_id, resumo, score, preco_sugestao) VALUES (?, ?, ?, ?)`,
      [req.params.id, resposta.resumo, resposta.score, resposta.preco_sugestao]
    );

    res.json(resposta);
  } catch (error) { console.error('Erro na análise IA:', error); res.status(500).json({ erro: error.message }); }
});

app.get('/api/imoveis/:id/analise', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM analises_ia WHERE imovel_id = ? ORDER BY data_analise DESC LIMIT 1`, [req.params.id]);
    res.json(rows[0] || {});
  } catch (error) { res.status(500).json({ erro: error.message }); }
});

async function analisarPreco(im) {
  const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

  const prompt = `Você é um especialista em mercado imobiliário brasileiro. Hoje é ${hoje}.

Pesquise na web anúncios REAIS, ATIVOS e ATUAIS de imóveis à venda no bairro "${im.bairro}" (mesma cidade/região), comparáveis em tipo, tamanho e faixa de preço, para embasar sua análise com dados de mercado reais e recentes.

Imóvel a ser analisado:
Título: ${im.titulo}
Preço: R$ ${Number(im.preco).toLocaleString('pt-BR')}
Bairro: ${im.bairro}
Tipo: ${im.tipo || 'não informado'}
Quartos: ${im.quartos || 'não informado'}
Banheiros: ${im.banheiros || 'não informado'}
Área: ${im.area_m2 ? im.area_m2 + 'm²' : 'não informado'}
Descrição: ${im.descricao || 'sem descrição'}

Instruções importantes:
- Baseie a análise exclusivamente em dados reais encontrados na pesquisa. Não invente preços de referência.
- Se encontrar poucos ou nenhum comparável real, diga isso claramente no resumo e reduza a confiança da análise (não force uma conclusão).
- Considere o preço por m² da região ao avaliar se o imóvel está caro, barato ou justo.
- "tempo_venda" deve refletir a velocidade típica de giro de imóveis parecidos nessa região, com base no que encontrar.

Ao final, responda APENAS com um bloco JSON (sem texto antes ou depois, sem markdown) exatamente neste formato:
{
  "resumo": "Análise breve em 2-3 frases, citando os comparáveis reais encontrados (site/preço) que embasaram a conclusão",
  "score": número entre 0 e 100,
  "parecer": "Caro", "Barato", ou "Justo",
  "tempo_venda": "15-30 dias" ou "30-60 dias" ou "60+ dias",
  "preco_sugestao": número ou null,
  "oportunidade": true ou false
}`;

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1500,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
    messages: [{ role: "user", content: prompt }],
  });

  const textoCompleto = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extrairJSON(textoCompleto);
}

app.post('/api/analisar-avulso', async (req, res) => {
  try {
    const { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao } = req.body;
    if (!titulo || !preco || !bairro) return res.status(400).json({ erro: 'Dados insuficientes para análise' });
    const resposta = await analisarPreco({ titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao });
    res.json(resposta);
  } catch (error) { console.error('Erro na análise avulsa:', error); res.status(500).json({ erro: error.message }); }
});

app.post('/api/buscar-anuncios', async (req, res) => {
  try {
    const { cidade, bairro, tipo, preco_min, preco_max, quartos_min, banheiros_min, vagas_min, area_min, area_max, detalhes } = req.body;
    if (!bairro) return res.status(400).json({ erro: 'Informe o bairro para buscar' });

    const criterios = [
      `Localização: ${bairro}${cidade ? `, ${cidade}` : ''}`,
      tipo && `Tipo: ${tipo}`,
      preco_min && `Preço mínimo: R$ ${preco_min}`,
      preco_max && `Preço máximo: R$ ${preco_max}`,
      quartos_min && `Mínimo de ${quartos_min} quarto(s)`,
      banheiros_min && `Mínimo de ${banheiros_min} banheiro(s)`,
      vagas_min && `Mínimo de ${vagas_min} vaga(s) de garagem`,
      area_min && `Área mínima: ${area_min}m²`,
      area_max && `Área máxima: ${area_max}m²`,
      detalhes && `Detalhes adicionais: ${detalhes}`,
    ].filter(Boolean).join('\n');

    const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

    const prompt = `Você é um assistente especializado em buscar imóveis à venda no Brasil. Hoje é ${hoje}.

Pesquise na web anúncios REAIS e ATIVOS (não expirados, não removidos) de imóveis à venda em portais confiáveis como OLX, Viva Real, Zap Imóveis, Imovelweb e QuintoAndar, que combinem com estes critérios:

${criterios}

Instruções importantes:
- Priorize anúncios que atendam ao MÁXIMO de critérios informados. Se não houver correspondência exata, inclua os mais próximos, mas nunca invente características que não constam no anúncio original.
- Extraia os dados diretamente do anúncio real encontrado na pesquisa. Não estime, não arredonde e não crie valores fictícios.
- O campo "link" deve ser a URL direta da página do anúncio específico, nunca a home do site ou uma página de busca genérica.
- Não repita o mesmo imóvel mais de uma vez, mesmo que apareça em mais de um site.
- Se o anúncio mencionar EXPLICITAMENTE aceitar parceria/comissão com outros corretores, marque "aceita_parceria" como true. Se mencionar EXPLICITAMENTE que não aceita, marque false. Se não houver nenhuma menção sobre isso, marque null (não deduza).
- Ordene os resultados do mais barato para o mais caro.
- Se não encontrar nenhum anúncio real correspondente, retorne a lista vazia. Nunca invente anúncios fictícios para preencher a lista.

Encontre até 8 anúncios reais e retorne APENAS um bloco JSON (sem texto antes ou depois, sem markdown) neste formato exato:
{
  "anuncios": [
    {
      "titulo": "título do anúncio",
      "preco": número (só o valor, sem R$),
      "bairro": "bairro",
      "cidade": "cidade",
      "tipo": "apartamento/casa/terreno/comercial",
      "quartos": número ou null,
      "banheiros": número ou null,
      "vagas": número ou null,
      "area_m2": número ou null,
      "link": "URL real e direta do anúncio",
      "site_origem": "nome do site",
      "telefone": "telefone se disponível no anúncio, senão null",
      "aceita_parceria": true, false, ou null
    }
  ]
}`;

    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      messages: [{ role: "user", content: prompt }],
    });

    const textoCompleto = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const resposta = extrairJSON(textoCompleto);
    res.json(resposta);
  } catch (error) { console.error('Erro ao buscar anúncios:', error); res.status(500).json({ erro: error.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
