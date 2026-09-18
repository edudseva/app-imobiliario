const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');

dotenv.config();
const app = express();

// Railway fica atrás de proxy: sem isso o rate limit enxerga todo mundo como um IP só
app.set('trust proxy', 1);

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

// ============ CONFIGURAÇÃO ============

// Inteiros validados aqui porque alguns vão direto no SQL (nunca vêm do usuário).
const CACHE_HORAS = inteiroEntre(process.env.CACHE_HORAS, 6, 1, 168);
const ANALISE_CACHE_HORAS = inteiroEntre(process.env.ANALISE_CACHE_HORAS, 24, 1, 168);
const LIMITE_BUSCAS_DIA = inteiroEntre(process.env.LIMITE_BUSCAS_DIA, 40, 1, 1000);
const LIMITE_ANALISES_DIA = inteiroEntre(process.env.LIMITE_ANALISES_DIA, 60, 1, 1000);
const CODIGO_CONVITE = process.env.CODIGO_CONVITE || '';

function inteiroEntre(valor, padrao, minimo, maximo) {
  const n = parseInt(valor, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(n, minimo), maximo);
}

// Sem segredo fixo, todo deploy derruba os logins. Avisa alto em vez de falhar calado.
const JWT_SEGREDO = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('ATENCAO: JWT_SECRET nao configurado. Usando segredo temporario.');
  console.warn('Todo mundo sera deslogado a cada deploy. Configure JWT_SECRET no Railway.');
}
if (!CODIGO_CONVITE) {
  console.warn('CODIGO_CONVITE nao configurado: cadastro de novas contas esta DESLIGADO.');
}

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============ ERROS ============

// Detalhe do erro vai pro log, nunca pro navegador.
function falhou(res, contexto, error, status = 500) {
  console.error(`[${contexto}]`, error);
  res.status(status).json({ erro: 'Não foi possível concluir a operação. Tente de novo.' });
}

// ============ BANCO ============

async function colunaExiste(tabela, coluna) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [tabela, coluna]
  );
  return rows.length > 0;
}

// Cria/ajusta tudo sozinho no boot, sem precisar abrir o phpMyAdmin
async function prepararBanco() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome_imobiliaria VARCHAR(150) NOT NULL,
        email VARCHAR(160) NOT NULL UNIQUE,
        senha_hash VARCHAR(255) NOT NULL,
        plano VARCHAR(20) NOT NULL DEFAULT 'basico',
        ativo BOOLEAN NOT NULL DEFAULT TRUE,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS buscas_cache (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chave CHAR(64) NOT NULL,
        criterios TEXT,
        resultado LONGTEXT NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_chave_data (chave, criado_em)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS uso_diario (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        dia DATE NOT NULL,
        buscas INT NOT NULL DEFAULT 0,
        analises INT NOT NULL DEFAULT 0,
        UNIQUE KEY uk_usuario_dia (usuario_id, dia)
      )
    `);

    // Anúncios que o corretor marcou: favorito, contato feito e o que deu.
    // Guarda uma cópia dos dados porque o anúncio some do portal quando vende.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS anuncios_salvos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        chave CHAR(64) NOT NULL,
        titulo VARCHAR(400),
        link VARCHAR(900),
        site_origem VARCHAR(120),
        preco DECIMAL(12,2) NULL,
        bairro VARCHAR(150),
        cidade VARCHAR(150),
        dados LONGTEXT,
        favorito BOOLEAN NOT NULL DEFAULT FALSE,
        status VARCHAR(20) NULL,
        observacao TEXT,
        contatado_em TIMESTAMP NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_usuario_anuncio (usuario_id, chave),
        INDEX idx_salvos_usuario (usuario_id, favorito)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS analises_cache (
        id INT AUTO_INCREMENT PRIMARY KEY,
        chave CHAR(64) NOT NULL,
        resultado LONGTEXT NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_analise_chave_data (chave, criado_em)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS historico_buscas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        usuario_id INT NOT NULL,
        criterios TEXT NOT NULL,
        resultados INT NOT NULL DEFAULT 0,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_historico_usuario (usuario_id, criado_em)
      )
    `);

    // A carteira precisa ter dono, senão uma imobiliária enxerga a da outra.
    if (!(await colunaExiste('imoveis', 'usuario_id'))) {
      await pool.query('ALTER TABLE imoveis ADD COLUMN usuario_id INT NULL');
      await pool.query('ALTER TABLE imoveis ADD INDEX idx_imoveis_usuario (usuario_id)');
      console.log('Coluna usuario_id criada em imoveis. Imoveis antigos ficaram sem dono.');
    }

    await pool.query('DELETE FROM buscas_cache WHERE criado_em < (NOW() - INTERVAL 7 DAY)');
    await pool.query('DELETE FROM analises_cache WHERE criado_em < (NOW() - INTERVAL 7 DAY)');
    console.log(`Banco pronto. Cache: ${CACHE_HORAS}h. Teto: ${LIMITE_BUSCAS_DIA} buscas/dia.`);
  } catch (error) {
    console.error('Falha ao preparar o banco:', error.message);
  }
}

// ============ AUTENTICAÇÃO ============

function gerarToken(usuario) {
  return jwt.sign(
    { id: usuario.id, email: usuario.email, nome_imobiliaria: usuario.nome_imobiliaria },
    JWT_SEGREDO,
    { expiresIn: '30d' }
  );
}

async function autenticar(req, res, next) {
  const cabecalho = req.headers.authorization || '';
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Faça login para continuar' });

  try {
    const dados = jwt.verify(token, JWT_SEGREDO);
    const [rows] = await pool.query('SELECT id, nome_imobiliaria, email, plano, ativo FROM usuarios WHERE id = ?', [dados.id]);
    if (rows.length === 0 || !rows[0].ativo) {
      return res.status(401).json({ erro: 'Conta inativa ou inexistente' });
    }
    req.usuario = rows[0];
    next();
  } catch {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login de novo.' });
  }
}

const limitePorIp = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Espere alguns minutos.' },
});

const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Espere alguns minutos.' },
});

app.use('/api', limitePorIp);

// Teto diário por usuário: é o freio de mão do custo de API.
async function consumirCota(usuarioId, campo, teto) {
  const [rows] = await pool.query(
    'SELECT buscas, analises FROM uso_diario WHERE usuario_id = ? AND dia = CURDATE()',
    [usuarioId]
  );
  const usado = rows.length > 0 ? rows[0][campo] : 0;
  if (usado >= teto) return false;

  await pool.query(
    `INSERT INTO uso_diario (usuario_id, dia, ${campo}) VALUES (?, CURDATE(), 1)
     ON DUPLICATE KEY UPDATE ${campo} = ${campo} + 1`,
    [usuarioId]
  );
  return true;
}

app.post('/api/auth/registrar', limiteLogin, async (req, res) => {
  try {
    const { nome_imobiliaria, email, senha, codigo } = req.body;

    if (!CODIGO_CONVITE) {
      return res.status(403).json({ erro: 'Cadastro fechado no momento.' });
    }
    if (codigo !== CODIGO_CONVITE) {
      return res.status(403).json({ erro: 'Código de convite inválido.' });
    }
    if (!nome_imobiliaria || !email || !senha) {
      return res.status(400).json({ erro: 'Preencha nome da imobiliária, email e senha.' });
    }
    if (String(senha).length < 8) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const emailLimpo = String(email).trim().toLowerCase();
    const [existe] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [emailLimpo]);
    if (existe.length > 0) {
      return res.status(409).json({ erro: 'Já existe uma conta com esse email.' });
    }

    const senhaHash = await bcrypt.hash(String(senha), 10);
    const [result] = await pool.query(
      'INSERT INTO usuarios (nome_imobiliaria, email, senha_hash) VALUES (?, ?, ?)',
      [String(nome_imobiliaria).trim(), emailLimpo, senhaHash]
    );

    const usuario = { id: result.insertId, email: emailLimpo, nome_imobiliaria: String(nome_imobiliaria).trim() };
    res.status(201).json({ token: gerarToken(usuario), usuario });
  } catch (error) { falhou(res, 'registrar', error); }
});

app.post('/api/auth/login', limiteLogin, async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Informe email e senha.' });

    const emailLimpo = String(email).trim().toLowerCase();
    const [rows] = await pool.query('SELECT * FROM usuarios WHERE email = ?', [emailLimpo]);

    // Mesma resposta para email inexistente e senha errada: não entrega quem tem conta.
    if (rows.length === 0 || !rows[0].ativo) {
      return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    }
    const confere = await bcrypt.compare(String(senha), rows[0].senha_hash);
    if (!confere) {
      return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    }

    const usuario = { id: rows[0].id, email: rows[0].email, nome_imobiliaria: rows[0].nome_imobiliaria };
    res.json({ token: gerarToken(usuario), usuario });
  } catch (error) { falhou(res, 'login', error); }
});

app.get('/api/auth/eu', autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT buscas, analises FROM uso_diario WHERE usuario_id = ? AND dia = CURDATE()',
      [req.usuario.id]
    );
    const uso = rows[0] || { buscas: 0, analises: 0 };
    res.json({
      usuario: req.usuario,
      uso_hoje: {
        buscas: uso.buscas,
        buscas_restantes: Math.max(LIMITE_BUSCAS_DIA - uso.buscas, 0),
        analises: uso.analises,
        analises_restantes: Math.max(LIMITE_ANALISES_DIA - uso.analises, 0),
      },
    });
  } catch (error) { falhou(res, 'eu', error); }
});

// ============ AUXILIARES ============

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

// ============ CACHE DE BUSCAS ============

// Mesmos critérios, escritos de formas diferentes, precisam gerar a mesma chave.
// "Águas Claras", "aguas claras" e " AGUAS CLARAS " são a mesma busca.
function normalizar(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function chaveDaBusca(criterios) {
  const base = [
    'cidade', 'bairro', 'tipo', 'preco_min', 'preco_max',
    'quartos_min', 'banheiros_min', 'vagas_min', 'area_min', 'area_max', 'detalhes',
  ]
    .map((campo) => `${campo}=${normalizar(criterios[campo])}`)
    .join('|');

  return crypto.createHash('sha256').update(base).digest('hex');
}

async function lerDoCache(chave) {
  try {
    const [rows] = await pool.query(
      `SELECT resultado, criado_em FROM buscas_cache
       WHERE chave = ? AND criado_em > (NOW() - INTERVAL ${CACHE_HORAS} HOUR)
       ORDER BY criado_em DESC LIMIT 1`,
      [chave]
    );
    if (rows.length === 0) return null;
    return { anuncios: JSON.parse(rows[0].resultado), buscado_em: rows[0].criado_em };
  } catch (error) {
    console.error('Falha ao ler cache (seguindo sem ele):', error.message);
    return null;
  }
}

async function gravarNoCache(chave, criterios, anuncios) {
  try {
    await pool.query(
      'INSERT INTO buscas_cache (chave, criterios, resultado) VALUES (?, ?, ?)',
      [chave, JSON.stringify(criterios), JSON.stringify(anuncios)]
    );
  } catch (error) {
    console.error('Falha ao gravar cache (resultado foi entregue mesmo assim):', error.message);
  }
}

// ============ ANÚNCIOS SALVOS E HISTÓRICO ============

// Identidade do anúncio. O link é o melhor identificador; sem ele, título + portal.
function chaveDoAnuncio(anuncio) {
  const base = anuncio.link
    ? normalizar(anuncio.link)
    : `${normalizar(anuncio.site_origem)}|${normalizar(anuncio.titulo)}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}

const STATUS_VALIDOS = ['contatado', 'respondeu', 'aceita_parceria', 'recusou', 'sem_resposta'];

app.get('/api/salvos', autenticar, async (req, res) => {
  try {
    let query = 'SELECT * FROM anuncios_salvos WHERE usuario_id = ?';
    const params = [req.usuario.id];
    if (req.query.favorito === '1') query += ' AND favorito = TRUE';
    if (req.query.status && STATUS_VALIDOS.includes(req.query.status)) {
      query += ' AND status = ?';
      params.push(req.query.status);
    }
    query += ' ORDER BY atualizado_em DESC LIMIT 200';

    const [rows] = await pool.query(query, params);
    res.json(rows.map((r) => ({ ...r, dados: r.dados ? JSON.parse(r.dados) : null })));
  } catch (error) { falhou(res, 'listar salvos', error); }
});

// Cria ou atualiza. Só mexe no que veio no corpo, o resto fica como estava.
app.post('/api/salvos', autenticar, async (req, res) => {
  try {
    const { anuncio, favorito, status, observacao } = req.body;
    if (!anuncio || (!anuncio.titulo && !anuncio.link)) {
      return res.status(400).json({ erro: 'Anúncio inválido' });
    }
    if (status !== undefined && status !== null && !STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido' });
    }

    const chave = chaveDoAnuncio(anuncio);
    const contatouAgora = status === 'contatado' ? 'NOW()' : 'contatado_em';

    await pool.query(
      `INSERT INTO anuncios_salvos
         (usuario_id, chave, titulo, link, site_origem, preco, bairro, cidade, dados, favorito, status, observacao, contatado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${status === 'contatado' ? 'NOW()' : 'NULL'})
       ON DUPLICATE KEY UPDATE
         dados = VALUES(dados),
         preco = VALUES(preco),
         favorito = ${favorito === undefined ? 'favorito' : 'VALUES(favorito)'},
         status = ${status === undefined ? 'status' : 'VALUES(status)'},
         observacao = ${observacao === undefined ? 'observacao' : 'VALUES(observacao)'},
         contatado_em = ${contatouAgora}`,
      [
        req.usuario.id,
        chave,
        (anuncio.titulo || '').slice(0, 400),
        (anuncio.link || '').slice(0, 900) || null,
        (anuncio.site_origem || '').slice(0, 120),
        anuncio.preco ? parseFloat(anuncio.preco) : null,
        (anuncio.bairro || '').slice(0, 150),
        (anuncio.cidade || '').slice(0, 150),
        JSON.stringify(anuncio),
        favorito === undefined ? false : Boolean(favorito),
        status === undefined ? null : status,
        observacao === undefined ? null : observacao,
      ]
    );

    const [rows] = await pool.query(
      'SELECT * FROM anuncios_salvos WHERE usuario_id = ? AND chave = ?',
      [req.usuario.id, chave]
    );
    const salvo = rows[0];
    res.json({ ...salvo, dados: salvo.dados ? JSON.parse(salvo.dados) : null });
  } catch (error) { falhou(res, 'salvar anuncio', error); }
});

app.delete('/api/salvos/:chave', autenticar, async (req, res) => {
  try {
    const [result] = await pool.query(
      'DELETE FROM anuncios_salvos WHERE usuario_id = ? AND chave = ?',
      [req.usuario.id, req.params.chave]
    );
    if (result.affectedRows === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { falhou(res, 'remover salvo', error); }
});

app.get('/api/historico', autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, criterios, resultados, criado_em FROM historico_buscas WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 15',
      [req.usuario.id]
    );
    res.json(rows.map((r) => ({ ...r, criterios: JSON.parse(r.criterios) })));
  } catch (error) { falhou(res, 'listar historico', error); }
});

async function registrarHistorico(usuarioId, criterios, resultados) {
  try {
    const limpos = Object.fromEntries(
      Object.entries(criterios).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    );
    await pool.query(
      'INSERT INTO historico_buscas (usuario_id, criterios, resultados) VALUES (?, ?, ?)',
      [usuarioId, JSON.stringify(limpos), resultados]
    );
    // Mantém só as 15 últimas por usuário.
    await pool.query(
      `DELETE FROM historico_buscas
       WHERE usuario_id = ? AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM historico_buscas WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 15
         ) recentes
       )`,
      [usuarioId, usuarioId]
    );
  } catch (error) {
    console.error('Falha ao registrar historico (busca foi entregue mesmo assim):', error.message);
  }
}

// ============ CARTEIRA DE IMÓVEIS (do corretor logado) ============

app.get('/api/imoveis', autenticar, async (req, res) => {
  try {
    const { bairro, tipo, preco_min, preco_max } = req.query;
    let query = 'SELECT * FROM imoveis WHERE status = ? AND usuario_id = ?';
    let params = ['ativo', req.usuario.id];
    if (bairro && bairro.trim()) { query += ' AND bairro LIKE ?'; params.push(`%${bairro}%`); }
    if (tipo && tipo.trim()) { query += ' AND tipo = ?'; params.push(tipo); }
    if (preco_min) { query += ' AND preco >= ?'; params.push(parseFloat(preco_min)); }
    if (preco_max) { query += ' AND preco <= ?'; params.push(parseFloat(preco_max)); }
    query += ' ORDER BY criado_em DESC';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) { falhou(res, 'listar imoveis', error); }
});

app.get('/api/imoveis/:id', autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(rows[0]);
  } catch (error) { falhou(res, 'ver imovel', error); }
});

app.post('/api/imoveis', autenticar, async (req, res) => {
  try {
    const { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email } = req.body;
    if (!titulo || !preco || !bairro) return res.status(400).json({ erro: 'Campos obrigatórios: título, preço, bairro' });
    const [result] = await pool.query(
      `INSERT INTO imoveis (usuario_id, titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao, contato_telefone, contato_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.usuario.id, titulo, parseFloat(preco), bairro, tipo, quartos || null, banheiros || null, area_m2 || null, descricao, contato_telefone, contato_email]
    );
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) { falhou(res, 'criar imovel', error); }
});

app.delete('/api/imoveis/:id', autenticar, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM imoveis WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (result.affectedRows === 0) return res.status(404).json({ erro: 'Não encontrado' });
    res.json({ ok: true });
  } catch (error) { falhou(res, 'remover imovel', error); }
});

app.post('/api/imoveis/:id/analisar', autenticar, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM imoveis WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (rows.length === 0) return res.status(404).json({ erro: 'Não encontrado' });

    const im = rows[0];
    const r = await obterAnalise(req.usuario.id, {
      titulo: im.titulo, preco: im.preco, bairro: im.bairro, tipo: im.tipo,
      quartos: im.quartos, banheiros: im.banheiros, area_m2: im.area_m2, descricao: im.descricao,
    });
    if (!r.ok) return res.status(r.status).json({ erro: r.erro });

    await pool.query(
      'INSERT INTO analises_ia (imovel_id, resumo, score, preco_sugestao) VALUES (?, ?, ?, ?)',
      [req.params.id, r.resposta.resumo, r.resposta.score, r.resposta.preco_sugestao]
    );

    res.json(r.resposta);
  } catch (error) { falhou(res, 'analisar imovel', error); }
});

app.get('/api/imoveis/:id/analise', autenticar, async (req, res) => {
  try {
    const [dono] = await pool.query('SELECT id FROM imoveis WHERE id = ? AND usuario_id = ?', [req.params.id, req.usuario.id]);
    if (dono.length === 0) return res.status(404).json({ erro: 'Não encontrado' });
    const [rows] = await pool.query(
      'SELECT * FROM analises_ia WHERE imovel_id = ? ORDER BY data_analise DESC LIMIT 1',
      [req.params.id]
    );
    res.json(rows[0] || {});
  } catch (error) { falhou(res, 'ver analise', error); }
});

// ============ ANÁLISE DE PREÇO ============

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
    model: 'claude-sonnet-5',
    max_tokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: prompt }],
  });

  const textoCompleto = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return extrairJSON(textoCompleto);
}

// O mesmo imóvel analisado duas vezes no mesmo dia dá o mesmo parecer.
// Não faz sentido pagar de novo por isso.
function chaveDaAnalise(im) {
  const base = [im.titulo, im.preco, im.bairro, im.tipo, im.quartos, im.banheiros, im.area_m2]
    .map(normalizar)
    .join('|');
  return crypto.createHash('sha256').update(base).digest('hex');
}

// Ordem que importa: cache primeiro, cota depois, IA por último.
// Assim resultado guardado nunca consome a cota diária do corretor.
async function obterAnalise(usuarioId, im) {
  const chave = chaveDaAnalise(im);

  try {
    const [rows] = await pool.query(
      `SELECT resultado, criado_em FROM analises_cache
       WHERE chave = ? AND criado_em > (NOW() - INTERVAL ${ANALISE_CACHE_HORAS} HOUR)
       ORDER BY criado_em DESC LIMIT 1`,
      [chave]
    );
    if (rows.length > 0) {
      return { ok: true, resposta: { ...JSON.parse(rows[0].resultado), do_cache: true, analisado_em: rows[0].criado_em } };
    }
  } catch (error) {
    console.error('Falha ao ler cache de analise (seguindo sem ele):', error.message);
  }

  const temCota = await consumirCota(usuarioId, 'analises', LIMITE_ANALISES_DIA);
  if (!temCota) {
    return { ok: false, status: 429, erro: `Limite de ${LIMITE_ANALISES_DIA} análises por dia atingido.` };
  }

  const resposta = await analisarPreco(im);

  try {
    await pool.query('INSERT INTO analises_cache (chave, resultado) VALUES (?, ?)', [chave, JSON.stringify(resposta)]);
  } catch (error) {
    console.error('Falha ao gravar cache de analise (resultado foi entregue):', error.message);
  }

  return { ok: true, resposta: { ...resposta, do_cache: false, analisado_em: new Date() } };
}

// Análise avulsa: recebe os dados direto no corpo, sem precisar estar salvo no banco
app.post('/api/analisar-avulso', autenticar, async (req, res) => {
  try {
    const { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao } = req.body;
    if (!titulo || !preco || !bairro) return res.status(400).json({ erro: 'Dados insuficientes para análise' });

    const r = await obterAnalise(req.usuario.id, { titulo, preco, bairro, tipo, quartos, banheiros, area_m2, descricao });
    if (!r.ok) return res.status(r.status).json({ erro: r.erro });
    res.json(r.resposta);
  } catch (error) { falhou(res, 'analise avulsa', error); }
});

// ============ BUSCA DE ANÚNCIOS REAIS NA WEB ============

app.post('/api/buscar-anuncios', autenticar, async (req, res) => {
  try {
    const entrada = { ...req.query, ...req.body };
    const { cidade, bairro, tipo, preco_min, preco_max, quartos_min, banheiros_min, vagas_min, area_min, area_max, detalhes, forcar } = entrada;
    if (!bairro) return res.status(400).json({ erro: 'Informe o bairro para buscar' });

    const criterios = {
      cidade, bairro, tipo, preco_min, preco_max,
      quartos_min, banheiros_min, vagas_min, area_min, area_max, detalhes,
    };
    const chave = chaveDaBusca(criterios);
    const ignorarCache = forcar === '1' || forcar === 1 || forcar === true || forcar === 'true';

    // Cache não consome cota: resultado salvo não custa API.
    if (!ignorarCache) {
      const salvo = await lerDoCache(chave);
      if (salvo) {
        console.log(`Cache HIT ${chave.slice(0, 8)} (${bairro}), nenhuma chamada de IA`);
        await registrarHistorico(req.usuario.id, criterios, salvo.anuncios.length);
        return res.json({ anuncios: salvo.anuncios, do_cache: true, buscado_em: salvo.buscado_em });
      }
    }

    const temCota = await consumirCota(req.usuario.id, 'buscas', LIMITE_BUSCAS_DIA);
    if (!temCota) {
      return res.status(429).json({ erro: `Limite de ${LIMITE_BUSCAS_DIA} buscas por dia atingido. Volta amanhã.` });
    }

    console.log(`Cache MISS ${chave.slice(0, 8)} (${bairro}), consultando a IA`);

    const linhasCriterios = [
      `Localização: ${bairro}${cidade ? `, ${cidade}` : ''}`,
      tipo && `Tipo: ${tipo}`,
      preco_min && `Preço mínimo: R$ ${preco_min}`,
      preco_max && `Preço máximo: R$ ${preco_max}`,
      quartos_min && `Mínimo de ${quartos_min} quarto(s)`,
      banheiros_min && `Mínimo de ${banheiros_min} banheiro(s)`,
      vagas_min && `Mínimo de ${vagas_min} vaga(s) de garagem`,
      area_min && `Área mínima: ${area_min}m²`,
      area_max && `Área máxima: ${area_max}m²`,
      detalhes && `Preferências adicionais (use para priorizar, nunca para descartar): ${detalhes}`,
    ].filter(Boolean).join('\n');

    const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });

    const prompt = `Você é um assistente especializado em buscar imóveis à venda no Brasil. Hoje é ${hoje}.

Encontre anúncios REAIS e ATIVOS de imóveis à venda em portais como OLX, Viva Real, Zap Imóveis, Imovelweb, DF Imóveis, MGF Imóveis e QuintoAndar, que combinem com estes critérios:

${linhasCriterios}

Método obrigatório de trabalho:
1. Use web_search para localizar as páginas de resultado dos portais que atendam aos critérios.
2. Use web_fetch para ABRIR essas páginas de listagem e extrair de dentro delas os anúncios individuais, com a URL específica de cada imóvel, o preço e as características reais.
3. Se útil, use web_fetch novamente na página do anúncio individual para confirmar preço, características e telefone de contato.

Priorize portais que publicam o telefone do anunciante na própria página, porque o objetivo é permitir o contato imediato.

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

Traga o maior número possível de anúncios reais que atendam aos critérios, até 20. Não pare em poucos resultados se houver mais disponíveis nos portais. Nunca descarte um anúncio apenas porque não conseguiu confirmar as preferências adicionais no texto do anúncio.

Responda APENAS com um bloco JSON (sem texto antes ou depois, sem markdown):
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
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
        {
          type: 'web_fetch_20250910',
          name: 'web_fetch',
          max_uses: 10,
          max_content_tokens: 6000,
        },
      ],
      messages: [{ role: 'user', content: prompt }],
    });

    const textoCompleto = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    if (process.env.DEBUG_BUSCA === '1') {
      console.log('=== DIAGNOSTICO BUSCA ===');
      console.log('stop_reason:', message.stop_reason);
      console.log('tipos de bloco:', message.content.map((b) => b.type).join(', '));
      console.log('tamanho do texto:', textoCompleto.length);
      console.log('resposta bruta:', textoCompleto.slice(0, 2000));
      console.log('=========================');
    }

    const resposta = extrairJSON(textoCompleto);

    const anuncios = (resposta.anuncios || []).map((a) => ({
      ...a,
      link_direto: ehLinkDeAnuncio(a.link),
      link: ehLinkDeAnuncio(a.link) ? a.link : null,
    }));

    // só vale guardar busca que achou alguma coisa
    if (anuncios.length > 0) {
      await gravarNoCache(chave, criterios, anuncios);
    }
    await registrarHistorico(req.usuario.id, criterios, anuncios.length);

    res.json({ anuncios, do_cache: false, buscado_em: new Date() });
  } catch (error) { falhou(res, 'buscar anuncios', error); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  await prepararBanco();
});
