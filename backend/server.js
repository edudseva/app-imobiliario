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
  if (!textoCompleto || !textoCompleto.trim()) {
    throw new Error('IA retornou resposta vazia');
  }

  // remove cercas de markdown, se vierem
  let texto = textoCompleto.replace(/```json/gi, '').replace(/```/g, '');

  // pega do primeiro abre chaves até o último fecha chaves
  const inicio = texto.indexOf('{');
  const fim = texto.lastIndexOf('}');
  if (inicio === -1 || fim === -1) {
    throw new Error('Nenhum bloco JSON encontrado na resposta: ' + textoCompleto.slice(0, 300));
  }
  texto = texto.slice(inicio, fim + 1);

  // remove vírgulas sobrando antes de } ou ]
  texto = texto.replace(/,(\s*[}\]])/g, '$1');

  try {
    return JSON.parse(texto);
  } catch (erro) {
    console.error('Falha ao parsear JSON. Motivo:', erro.message);
    console.error('Texto que falhou:', texto.slice(0, 1500));
    throw new Error('Resposta da IA veio malformada: ' + erro.message);
  }
}

// Detecta se a URL aponta para um anúncio específico ou só para uma página de listagem
function ehLinkDeAnuncio(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const caminho = new URL(url).pathname;
    const segmentos = caminho.split('/').filter(Boolean);
    const temIdLongo = /\d{6,}/.test(caminho);
    const temSlugDetalhado = segmentos.some((s) => s.length > 25);
    return temIdLongo || temSlugDetalhado || segmentos.length >= 5;
  } catch {
    return false;
  }
}

// ============ CARTEIRA DE IMÓVEIS (cadastro manual do corretor) ============

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

// ============ FUNÇÃO COMPARTILHADA DE ANÁLISE ============

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
    max_tokens: 6000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: prompt }],
  });

  const textoCompleto = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extrairJSON(textoCompleto);
}

// Análise avulsa: recebe os dados direto no corpo, sem precisar estar salvo no banco
app.post('/api/analisar-avulso', async (req, res) => {
  try {
    const { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao } = req.body;
    if (!titulo || !preco || !bairro) return res.status(400).json({ erro: 'Dados insuficientes para análise' });
    const resposta = await analisarPreco({ titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao });
    res.json(resposta);
  } catch (error) { console.error('Erro na análise avulsa:', error); res.status(500).json({ erro: error.message }); }
});

// ============ BUSCA DE ANÚNCIOS REAIS NA WEB ============

app.all('/api/buscar-anuncios', async (req, res) => {
  try {
    const { cidade, bairro, tipo, preco_min, preco_max, quartos_min, banheiros_min, vagas_min, area_min, area_max, detalhes } = { ...req.query, ...req.body };
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

Encontre anúncios REAIS e ATIVOS de imóveis à venda em portais como OLX, Viva Real, Zap Imóveis, Imovelweb, DF Imóveis, MGF Imóveis e QuintoAndar, que combinem com estes critérios:

${criterios}

Método obrigatório de trabalho:
1. Use web_search para localizar as páginas de resultado dos portais que atendam aos critérios.
2. Use web_fetch para ABRIR essas páginas de listagem e extrair de dentro delas os anúncios individuais, com a URL específica de cada imóvel, o preço e as características reais.
3. Se útil, use web_fetch novamente na página do anúncio individual para confirmar preço, características e telefone de contato.

Regras rígidas sobre o campo "link":
- Deve ser a URL da PÁGINA DO ANÚNCIO ESPECÍFICO daquele imóvel, com identificador ou slug próprio do imóvel.
- NUNCA use a URL de uma página de busca, listagem, categoria ou home do portal. Exemplos do que é PROIBIDO: /venda/df/brasilia/apartamento, /imoveis/venda, qualquer URL com parâmetros de filtro.
- Se você não conseguir obter a URL do anúncio individual, coloque "link": null. Não preencha com a página de listagem.

Demais regras:
- Extraia os dados do anúncio real. Não estime, não arredonde, não invente valores.
- Não repita o mesmo imóvel mais de uma vez.
- Marque "aceita_parceria" como true apenas se o anúncio disser explicitamente que aceita parceria ou comissão com corretores. Marque false apenas se disser explicitamente que não aceita. Caso contrário, null.
- Ordene do mais barato para o mais caro.
- Se não encontrar nenhum anúncio real correspondente, retorne a lista vazia. Nunca invente anúncios.

Encontre até 8 anúncios e responda APENAS com um bloco JSON (sem texto antes ou depois, sem markdown):
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
      "link": "URL direta do anúncio individual, ou null",
      "site_origem": "nome do site",
      "telefone": "telefone se disponível, senão null",
      "aceita_parceria": true, false, ou null
    }
  ]
}`;

        const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 16000,
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 3 },
        {
          type: "web_fetch_20250910",
          name: "web_fetch",
          max_uses: 4,
          max_content_tokens: 6000,
        },
      ],
      messages: [{ role: "user", content: prompt }],
    });

        const textoCompleto = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

    console.log('=== DIAGNOSTICO BUSCA ===');
    console.log('stop_reason:', message.stop_reason);
    console.log('tipos de bloco:', message.content.map(b => b.type).join(', '));
    console.log('tamanho do texto:', textoCompleto.length);
    console.log('resposta bruta:', textoCompleto.slice(0, 2000));
    console.log('=========================');

    const resposta = extrairJSON(textoCompleto);

    const anuncios = (resposta.anuncios || []).map((a) => ({
      ...a,
      link_direto: ehLinkDeAnuncio(a.link),
      link: ehLinkDeAnuncio(a.link) ? a.link : null,
    }));

    res.json({ anuncios });
  } catch (error) { console.error('Erro ao buscar anúncios:', error); res.status(500).json({ erro: error.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
