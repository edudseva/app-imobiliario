import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import './App.css';
import './complementos.css';

const API_BASE = process.env.REACT_APP_API_URL || 'https://app-imobiliario-production.up.railway.app/api';

// Atenção seletiva na primeira metade, retenção seletiva na segunda.
const FRASE = 'Mostra o que interessa. Guarda o que você não pode esquecer.';

const CHAVE_SESSAO = 'radar_sessao';
const CHAVE_PERFIL = 'radar_perfil_corretor';
const CHAVE_BUSCA = 'radar_ultima_busca';

// ============ ARMAZENAMENTO LOCAL ============

const lerLocal = (chave, padrao) => {
  try {
    const bruto = localStorage.getItem(chave);
    return bruto ? { ...padrao, ...JSON.parse(bruto) } : padrao;
  } catch {
    return padrao;
  }
};

const gravarLocal = (chave, valor) => {
  try {
    localStorage.setItem(chave, JSON.stringify(valor));
  } catch {
    // navegador em modo privado ou storage cheio: seguir sem persistir
  }
};

// ============ API ============

// Sem timeout o axios espera para sempre: foi o "carregando infinito".
// Chamadas comuns são rápidas; a busca tem prazo próprio, bem maior.
const TIMEOUT_PADRAO = 45000;
const TIMEOUT_BUSCA = 240000;

const api = axios.create({ baseURL: API_BASE, timeout: TIMEOUT_PADRAO });

const ehTempoEsgotado = (error) =>
  error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '');

api.interceptors.request.use((config) => {
  try {
    const bruto = localStorage.getItem(CHAVE_SESSAO);
    const token = bruto ? JSON.parse(bruto).token : null;
    if (token) config.headers.Authorization = `Bearer ${token}`;
  } catch {
    // sem token: a requisição segue e o backend responde 401
  }
  return config;
});

const mensagemDeErro = (error, padrao) => error?.response?.data?.erro || padrao;

// ============ AUXILIARES ============

const formatarPreco = (valor) => {
  if (valor === null || valor === undefined || valor === '') return 'Preço não informado';
  return Number(valor).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
};

// Aluguel mostra o valor mensal; venda (padrão) mostra só o valor.
const formatarPrecoAnuncio = (anuncio) => {
  const texto = formatarPreco(anuncio?.preco);
  return anuncio?.negocio === 'aluguel' && anuncio?.preco ? `${texto}/mês` : texto;
};

// Guarda só dígitos no estado e exibe no formato R$ 1.000.000 enquanto digita.
function InputMoeda({ value, onChange, placeholder }) {
  const digitos = String(value || '').replace(/\D/g, '');
  const exibido = digitos ? `R$ ${Number(digitos).toLocaleString('pt-BR')}` : '';
  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder={placeholder || 'R$ 0'}
      value={exibido}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').replace(/^0+/, ''))}
    />
  );
}

const montarLinkWhatsApp = (telefone, titulo) => {
  if (!telefone) return null;
  let numero = String(telefone).replace(/\D/g, '');
  if (numero.length < 10) return null;
  if (!numero.startsWith('55')) numero = '55' + numero;
  const msg = `Olá, vi o anúncio do imóvel "${titulo}". Ainda está disponível? Vocês trabalham com parceria entre corretores?`;
  return `https://wa.me/${numero}?text=${encodeURIComponent(msg)}`;
};

// Identidade estável do anúncio. Índice de array troca de dono quando a lista muda.
const idDoAnuncio = (anuncio, i) => anuncio.link || `${anuncio.site_origem || 's'}-${anuncio.titulo || i}`;

const formatarData = (d) => (d ? new Date(d).toLocaleDateString('pt-BR') : '');

const saudacao = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
};

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || '';

const dataPorExtenso = () =>
  new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

// Previsão em linguagem de gente. Passou da estimativa, para de prometer prazo.
const textoPrevisao = (segundos, estimativa) => {
  const restam = (estimativa || 45) - segundos;
  if (restam > 25) return `cerca de ${Math.round(restam / 5) * 5}s restantes`;
  if (restam > 8) return 'quase lá';
  if (restam > -30) return 'terminando';
  return 'esta busca está mais difícil que o normal';
};

const quandoFoi = (data) => {
  if (!data) return '';
  const minutos = Math.round((Date.now() - new Date(data).getTime()) / 60000);
  if (minutos < 2) return 'agora';
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.round(minutos / 60);
  return `há ${horas}h`;
};

// Só para exibir no texto de ajuda; quem manda de verdade é o backend.
const LIMITE_ALERTAS_VISIVEL = 5;

const ROTULOS_CRITERIOS = {
  cidade: 'Cidade',
  tipo: 'Tipo',
  preco_min: 'A partir de R$',
  preco_max: 'Até R$',
  quartos_min: 'Quartos',
  banheiros_min: 'Banheiros',
  vagas_min: 'Vagas',
  area_min: 'Área mín',
  area_max: 'Área máx',
  detalhes: 'Detalhes',
};

const resumoCriterios = (c) => {
  const partes = [c.negocio === 'aluguel' ? 'Aluguel' : 'Compra', c.consulta || c.bairro];
  Object.entries(ROTULOS_CRITERIOS).forEach(([campo, rotulo]) => {
    if (!c[campo]) return;
    const valor = campo === 'preco_min' || campo === 'preco_max'
      ? Number(c[campo]).toLocaleString('pt-BR')
      : c[campo];
    partes.push(`${rotulo}: ${valor}`);
  });
  return partes.filter(Boolean).join(' · ');
};

const FORM_BUSCA_INICIAL = {
  negocio: 'venda',
  consulta: '',
  cidade: '', bairro: '', tipo: '', preco_min: '', preco_max: '',
  quartos_min: '', banheiros_min: '', vagas_min: '', area_min: '', area_max: '', detalhes: '',
};

const EXEMPLOS_BUSCA = [
  'apartamento 2 quartos Águas Claras até 400 mil',
  'casa com 3 vagas no Lago Sul',
  'kitnet mobiliada perto do metrô Guará',
];

const FORM_PERFIL_INICIAL = {
  nome: '',
  email: '',
  telefone: '',
  mensagem: 'Olá, sou corretor e vi o anúncio deste imóvel. Ele ainda está disponível? Vocês trabalham com parceria entre corretores?',
};

const FORM_CARTEIRA_INICIAL = {
  titulo: '', preco: '', bairro: '', tipo: 'apartamento', quartos: '', banheiros: '',
  area_m2: '', descricao: '', contato_telefone: '', contato_email: '',
};

// ============ COMPONENTES ============
// Ficam fora do App de propósito: declarados dentro, o React os trata como
// componentes novos a cada render e remonta a subárvore inteira.

function BlocoAnalise({ dados }) {
  return (
    <div className="analise">
      <div className="analise-topo">
        <span className={`tag tag-${String(dados.parecer || '').toLowerCase()}`}>{dados.parecer}</span>
        <span className="analise-score">{dados.score}/100</span>
      </div>
      <div className="barra">
        <div className="barra-fill" style={{ width: `${dados.score || 0}%` }} />
      </div>
      <p className="analise-resumo">{dados.resumo}</p>
      <div className="analise-linhas">
        {dados.preco_sugestao ? (
          <span>Sugerido: <strong>{formatarPreco(dados.preco_sugestao)}</strong></span>
        ) : null}
        {dados.tempo_venda ? <span>Giro estimado: <strong>{dados.tempo_venda}</strong></span> : null}
        {dados.do_cache ? <span className="selo-cache">análise salva {quandoFoi(dados.analisado_em)}</span> : null}
      </div>
    </div>
  );
}

function BlocoContato({ anuncio, perfil, copiado, aoCopiar }) {
  const mensagem = `${perfil.mensagem || FORM_PERFIL_INICIAL.mensagem}\n\nImóvel: ${anuncio.titulo}`;
  const campos = [
    { rotulo: 'Nome', valor: perfil.nome },
    { rotulo: 'Email', valor: perfil.email },
    { rotulo: 'Telefone', valor: perfil.telefone },
    { rotulo: 'Mensagem', valor: mensagem, longo: true },
  ].filter((c) => c.valor);

  const tudo = [perfil.nome, perfil.email, perfil.telefone, mensagem].filter(Boolean).join('\n');

  return (
    <div className="contato-assistido">
      <p className="contato-titulo">Cole no formulário do portal</p>
      {campos.map((campo) => (
        <div className={`linha-copia ${campo.longo ? 'linha-longa' : ''}`} key={campo.rotulo}>
          <div className="linha-info">
            <span className="linha-rotulo">{campo.rotulo}</span>
            <span className="linha-valor">{campo.valor}</span>
          </div>
          <button className="btn btn-copiar" onClick={() => aoCopiar(campo.valor, campo.rotulo)}>
            {copiado === campo.rotulo ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      ))}
      <div className="linha-copia">
        <div className="linha-info">
          <span className="linha-rotulo">Tudo junto</span>
          <span className="linha-valor">Nome, email, telefone e mensagem</span>
        </div>
        <button className="btn btn-copiar" onClick={() => aoCopiar(tudo, 'tudo')}>
          {copiado === 'tudo' ? 'Copiado' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

function Login({ aoEntrar }) {
  const [modo, setModo] = useState('login');
  const [dados, setDados] = useState({ nome_imobiliaria: '', email: '', senha: '', codigo: '' });
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  const enviar = async (e) => {
    e.preventDefault();
    setEnviando(true);
    setErro('');
    try {
      const rota = modo === 'login' ? '/auth/login' : '/auth/registrar';
      const corpo = modo === 'login'
        ? { email: dados.email, senha: dados.senha }
        : dados;
      const res = await api.post(rota, corpo);
      aoEntrar(res.data);
    } catch (error) {
      setErro(mensagemDeErro(error, 'Não foi possível entrar agora.'));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="tela-login">
      <div className="caixa-login">
        <div className="marca marca-login">
          <span className="marca-icone">🏙️</span>
          <div>
            <h1>Radar Imobiliário</h1>
            <p className="frase">{FRASE}</p>
          </div>
        </div>

        {erro ? <div className="alerta alerta-erro">{erro}</div> : null}

        <form onSubmit={enviar}>
          {modo === 'registrar' ? (
            <label className="campo-largo">
              <span>Nome da imobiliária</span>
              <input
                type="text"
                value={dados.nome_imobiliaria}
                onChange={(e) => setDados({ ...dados, nome_imobiliaria: e.target.value })}
                required
              />
            </label>
          ) : null}

          <label className="campo-largo">
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              value={dados.email}
              onChange={(e) => setDados({ ...dados, email: e.target.value })}
              required
            />
          </label>

          <label className="campo-largo">
            <span>Senha</span>
            <input
              type="password"
              autoComplete={modo === 'login' ? 'current-password' : 'new-password'}
              value={dados.senha}
              onChange={(e) => setDados({ ...dados, senha: e.target.value })}
              required
            />
          </label>

          {modo === 'registrar' ? (
            <label className="campo-largo">
              <span>Código de convite</span>
              <input
                type="text"
                value={dados.codigo}
                onChange={(e) => setDados({ ...dados, codigo: e.target.value })}
                required
              />
            </label>
          ) : null}

          <button type="submit" className="btn btn-principal btn-bloco" disabled={enviando}>
            {enviando ? 'Aguarde...' : modo === 'login' ? 'Entrar' : 'Criar conta'}
          </button>
        </form>

        <button
          className="btn btn-texto btn-bloco"
          onClick={() => { setModo(modo === 'login' ? 'registrar' : 'login'); setErro(''); }}
        >
          {modo === 'login' ? 'Tenho um código de convite' : 'Já tenho conta'}
        </button>
      </div>
    </div>
  );
}

const STATUS_ROTULOS = {
  contatado: 'Contatado',
  respondeu: 'Respondeu',
  aceita_parceria: 'Aceita parceria',
  recusou: 'Não faz parceria',
  sem_resposta: 'Sem resposta',
};

function ControleStatus({ salvo, aoMarcarStatus }) {
  const atual = salvo?.status || '';
  return (
    <div className="status-linha">
      <span className="status-rotulo">Situação</span>
      <select
        className="status-select"
        value={atual}
        onChange={(e) => aoMarcarStatus(e.target.value || null)}
      >
        <option value="">Não contatado</option>
        {Object.entries(STATUS_ROTULOS).map(([valor, rotulo]) => (
          <option key={valor} value={valor}>{rotulo}</option>
        ))}
      </select>
    </div>
  );
}

// Linha de pendência do "Meu dia": o mínimo para decidir e agir sem sair da tela.
function ItemPendencia({ registro, aoMudarStatus }) {
  const anuncio = registro.dados || registro;
  const zap = montarLinkWhatsApp(anuncio.telefone, registro.titulo);

  return (
    <div className="pendencia">
      <div className="pendencia-info">
        <span className="pendencia-titulo">{registro.titulo}</span>
        <span className="pendencia-meta">
          {formatarPrecoAnuncio({ ...anuncio, preco: registro.preco })}
          {registro.site_origem ? ` · ${registro.site_origem}` : ''}
          {registro.contatado_em ? ` · contatado ${quandoFoi(registro.contatado_em)}` : ''}
        </span>
      </div>
      <div className="pendencia-acoes">
        <select
          className="status-select"
          value={registro.status || ''}
          onChange={(e) => aoMudarStatus(e.target.value)}
        >
          <option value="">Não contatado</option>
          {Object.entries(STATUS_ROTULOS).map(([v, r]) => (
            <option key={v} value={v}>{r}</option>
          ))}
        </select>
        {zap ? (
          <a className="btn btn-zap" href={zap} target="_blank" rel="noreferrer">Cobrar no WhatsApp</a>
        ) : registro.link ? (
          <a className="btn btn-secundario" href={registro.link} target="_blank" rel="noreferrer">Abrir anúncio</a>
        ) : null}
      </div>
    </div>
  );
}

function CartaoResultado({ anuncio, analise, analisando, perfil, perfilPreenchido, contatoAberto, copiado, salvo, aoAnalisar, aoAbrirContato, aoCopiar, aoFavoritar, aoMarcarStatus, aoContatar }) {
  const zap = montarLinkWhatsApp(anuncio.telefone, anuncio.titulo);
  const favorito = Boolean(salvo?.favorito);

  return (
    <article className={`card ${salvo?.status ? `card-${salvo.status}` : ''}`}>
      <div className="card-cabecalho">
        <div>
          <h3>{anuncio.titulo}</h3>
          <p className="local">
            {anuncio.bairro}
            {anuncio.cidade ? `, ${anuncio.cidade}` : ''}
            {anuncio.tipo ? ` · ${anuncio.tipo}` : ''}
          </p>
        </div>
        <div className="card-canto">
          <button
            className={`estrela ${favorito ? 'estrela-ativa' : ''}`}
            onClick={aoFavoritar}
            title={favorito ? 'Tirar dos favoritos' : 'Favoritar'}
            aria-label={favorito ? 'Tirar dos favoritos' : 'Favoritar'}
          >
            {favorito ? '★' : '☆'}
          </button>
          <span className="portal">{anuncio.site_origem}</span>
        </div>
      </div>

      <p className="preco">{formatarPrecoAnuncio(anuncio)}</p>

      <ul className="specs">
        {anuncio.quartos ? <li>{anuncio.quartos} quartos</li> : null}
        {anuncio.banheiros ? <li>{anuncio.banheiros} banheiros</li> : null}
        {anuncio.vagas ? <li>{anuncio.vagas} vagas</li> : null}
        {anuncio.area_m2 ? <li>{anuncio.area_m2} m²</li> : null}
      </ul>

      {anuncio.aceita_parceria === true ? (
        <span className="parceria parceria-sim">Anúncio menciona parceria</span>
      ) : anuncio.aceita_parceria === false ? (
        <span className="parceria parceria-nao">Anúncio informa que não faz parceria</span>
      ) : (
        <span className="parceria parceria-null">Parceria não informada, confirme no contato</span>
      )}

      {analise ? <BlocoAnalise dados={analise} /> : null}

      {contatoAberto ? (
        <BlocoContato anuncio={anuncio} perfil={perfil} copiado={copiado} aoCopiar={aoCopiar} />
      ) : null}

      {salvo?.status || salvo?.favorito ? (
        <ControleStatus salvo={salvo} aoMarcarStatus={aoMarcarStatus} />
      ) : null}

      <div className="card-acoes">
        {zap ? (
          <a className="btn btn-zap" href={zap} target="_blank" rel="noreferrer" onClick={aoContatar}>
            Falar no WhatsApp
          </a>
        ) : null}

        {!zap && anuncio.link ? (
          <button className="btn btn-principal" onClick={aoAbrirContato}>
            {contatoAberto ? 'Contato aberto' : 'Contatar pelo portal'}
          </button>
        ) : null}

        {anuncio.link ? (
          <a className="btn btn-secundario" href={anuncio.link} target="_blank" rel="noreferrer">Ver anúncio</a>
        ) : null}

        <button className="btn btn-texto" onClick={aoAnalisar} disabled={analisando}>
          {analisando ? 'Analisando...' : analise ? 'Analisar de novo' : 'Analisar preço com IA'}
        </button>
      </div>
    </article>
  );
}

// ============ APP ============

function App() {
  const [sessao, setSessao] = useState(() => lerLocal(CHAVE_SESSAO, null));
  const [uso, setUso] = useState(null);
  const [aba, setAba] = useState('dia');
  const [resumo, setResumo] = useState(null);
  const [mensagem, setMensagem] = useState(null);

  const [formBusca, setFormBusca] = useState(() => lerLocal(CHAVE_BUSCA, FORM_BUSCA_INICIAL));
  const [buscando, setBuscando] = useState(false);
  const [atualizando, setAtualizando] = useState(false);
  const [maisFiltros, setMaisFiltros] = useState(false);
  const [segundos, setSegundos] = useState(0);
  const [estimativa, setEstimativa] = useState(45);

  // Guarda o intervalo do acompanhamento para poder parar de qualquer lugar.
  const pollRef = useRef(null);
  const pararPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
  // Sair da tela não pode deixar um intervalo rodando para sempre.
  useEffect(() => () => pararPolling(), []);
  const [resultados, setResultados] = useState(null);
  const [infoCache, setInfoCache] = useState(null);
  const [analises, setAnalises] = useState({});
  const [analisando, setAnalisando] = useState({});

  const [perfil, setPerfil] = useState(() => lerLocal(CHAVE_PERFIL, FORM_PERFIL_INICIAL));
  const [contatoAberto, setContatoAberto] = useState(null);
  const [copiado, setCopiado] = useState(null);

  const [carteira, setCarteira] = useState([]);
  const [formCarteira, setFormCarteira] = useState(FORM_CARTEIRA_INICIAL);
  const [salvando, setSalvando] = useState(false);
  const [mostrarFormCarteira, setMostrarFormCarteira] = useState(false);

  // Anúncios marcados, indexados pelo mesmo id local que os cards usam.
  const [salvos, setSalvos] = useState({});
  const [historico, setHistorico] = useState([]);
  const [filtroSalvos, setFiltroSalvos] = useState('todos');

  const [alertas, setAlertas] = useState([]);
  const [rodando, setRodando] = useState({});
  const [imobiliaria, setImobiliaria] = useState(sessao?.usuario?.nome_imobiliaria || '');
  const [salvandoImobiliaria, setSalvandoImobiliaria] = useState(false);
  // email_ligado começa null (desconhecido) para a faixa de aviso não piscar antes de carregar.
  const [notificacoes, setNotificacoes] = useState({ notificar_email: true, email_notificacao: '', email_ligado: null });
  const [salvandoNotif, setSalvandoNotif] = useState(false);
  const [assinatura, setAssinatura] = useState(null);
  const [catalogo, setCatalogo] = useState(null);
  const [equipe, setEquipe] = useState(null);
  const [formMembro, setFormMembro] = useState({ nome: '', email: '', senha: '' });
  const [salvandoMembro, setSalvandoMembro] = useState(false);

  const aviso = (texto, tipo = 'info') => {
    setMensagem({ texto, tipo });
    if (tipo !== 'erro') setTimeout(() => setMensagem(null), 5000);
  };

  const sair = useCallback(() => {
    try { localStorage.removeItem(CHAVE_SESSAO); } catch { /* segue */ }
    setSessao(null);
    setResultados(null);
    setCarteira([]);
    setUso(null);
  }, []);

  const entrar = (dados) => {
    gravarLocal(CHAVE_SESSAO, dados);
    setSessao(dados);
  };

  const tratarErro = useCallback((error, padrao) => {
    if (error?.response?.status === 401) {
      sair();
      return;
    }
    aviso(mensagemDeErro(error, padrao), 'erro');
  }, [sair]);

  const carregarUso = useCallback(async () => {
    try {
      const res = await api.get('/auth/eu');
      setUso(res.data.uso_mes);
      if (res.data.assinatura) setAssinatura(res.data.assinatura);
      if (res.data.notificacoes) setNotificacoes(res.data.notificacoes);
    } catch (error) {
      if (error?.response?.status === 401) sair();
    }
  }, [sair]);

  useEffect(() => {
    if (sessao) carregarUso();
  }, [sessao, carregarUso]);

  // A busca agora é assíncrona: o servidor devolve um id na hora e a gente
  // pergunta o andamento. Enquanto isso a tela já mostra o resultado anterior,
  // se houver, em vez de ficar branca.
  const executarBusca = async (forcar, formAlvo) => {
    const alvo = formAlvo || formBusca;
    const temTexto = String(alvo.consulta || '').trim();
    const temBairro = String(alvo.bairro || '').trim();
    if (!temTexto && !temBairro) {
      aviso('Escreva o que você procura. Exemplo: apartamento 2 quartos Águas Claras até 400 mil', 'erro');
      return;
    }

    pararPolling();
    setBuscando(true);
    setAtualizando(false);
    setResultados(null);
    setInfoCache(null);
    setAnalises({});
    setContatoAberto(null);
    gravarLocal(CHAVE_BUSCA, alvo);

    try {
      const payload = Object.fromEntries(
        Object.entries(alvo).filter(([, v]) => String(v).trim() !== '')
      );
      if (forcar) payload.forcar = '1';
      const res = await api.post('/buscar-anuncios', payload);

      if (res.data.estado === 'pronto') {
        setResultados(res.data.anuncios || []);
        setInfoCache({ do_cache: res.data.do_cache, buscado_em: res.data.buscado_em });
        setBuscando(false);
        carregarUso();
        carregarHistorico();
        return;
      }

      // Busca começou. Mostra o resultado anterior na hora, se existir.
      if (res.data.estimativa) setEstimativa(res.data.estimativa);
      const anteriores = res.data.anuncios_anteriores || [];
      if (anteriores.length > 0) {
        setResultados(anteriores);
        setInfoCache({ do_cache: true, buscado_em: res.data.anteriores_de });
        setBuscando(false);
      }
      setAtualizando(true);
      acompanharBusca(res.data.busca_id);
    } catch (error) {
      if (ehTempoEsgotado(error)) {
        aviso('O servidor demorou para responder. Tente de novo em instantes.', 'erro');
      } else {
        tratarErro(error, 'Não foi possível iniciar a busca agora');
      }
      setResultados([]);
      setBuscando(false);
      setAtualizando(false);
    }
  };

  // Pergunta o andamento de 2 em 2 segundos até terminar.
  const acompanharBusca = (buscaId) => {
    if (!buscaId) return;
    const comecou = Date.now();

    pollRef.current = setInterval(async () => {
      if (Date.now() - comecou > TIMEOUT_BUSCA) {
        pararPolling();
        setBuscando(false);
        setAtualizando(false);
        aviso('A busca passou de 4 minutos. Tente afrouxar algum filtro ou ampliar a faixa de preço.', 'erro');
        return;
      }

      try {
        const res = await api.get(`/buscar-anuncios/${buscaId}`);
        setSegundos(res.data.segundos || 0);
        if (res.data.estimativa) setEstimativa(res.data.estimativa);

        if (res.data.estado === 'pronto') {
          pararPolling();
          setResultados(res.data.anuncios || []);
          setInfoCache({ do_cache: false, buscado_em: res.data.buscado_em });
          setBuscando(false);
          setAtualizando(false);
          carregarUso();
          carregarHistorico();
        } else if (res.data.estado === 'erro') {
          pararPolling();
          setBuscando(false);
          setAtualizando(false);
          aviso(res.data.erro || 'A busca não terminou desta vez.', 'erro');
        }
      } catch (error) {
        pararPolling();
        setBuscando(false);
        setAtualizando(false);
        tratarErro(error, 'Perdi o acompanhamento da busca');
      }
    }, 2000);
  };

  const analisarAnuncio = async (anuncio, id) => {
    setAnalisando((a) => ({ ...a, [id]: true }));
    try {
      const res = await api.post('/analisar-avulso', {
        titulo: anuncio.titulo,
        preco: anuncio.preco,
        bairro: anuncio.bairro,
        tipo: anuncio.tipo,
        quartos: anuncio.quartos,
        banheiros: anuncio.banheiros,
        area_m2: anuncio.area_m2,
        descricao: `${anuncio.tipo || ''} em ${anuncio.bairro || ''}${anuncio.cidade ? ', ' + anuncio.cidade : ''}`,
      });
      setAnalises((a) => ({ ...a, [id]: res.data }));
      carregarUso();
    } catch (error) {
      tratarErro(error, 'Não foi possível analisar este imóvel');
    } finally {
      setAnalisando((a) => ({ ...a, [id]: false }));
    }
  };

  const carregarSalvos = useCallback(async () => {
    try {
      const res = await api.get('/salvos');
      const mapa = {};
      (res.data || []).forEach((registro) => {
        mapa[idDoAnuncio(registro, registro.id)] = registro;
      });
      setSalvos(mapa);
    } catch (error) {
      tratarErro(error, 'Não foi possível carregar os salvos');
    }
  }, [tratarErro]);

  const carregarHistorico = useCallback(async () => {
    try {
      const res = await api.get('/historico');
      setHistorico(res.data || []);
    } catch (error) {
      if (error?.response?.status === 401) sair();
    }
  }, [sair]);

  // mudancas: { favorito } e/ou { status } e/ou { observacao }
  const marcarAnuncio = async (anuncio, id, mudancas) => {
    try {
      const res = await api.post('/salvos', { anuncio, ...mudancas });
      setSalvos((s) => ({ ...s, [id]: res.data }));
    } catch (error) {
      tratarErro(error, 'Não foi possível salvar a marcação');
    }
  };

  const removerSalvo = async (chave, id) => {
    try {
      await api.delete(`/salvos/${chave}`);
      setSalvos((s) => {
        const copia = { ...s };
        delete copia[id];
        return copia;
      });
    } catch (error) {
      tratarErro(error, 'Não foi possível remover');
    }
  };

  const carregarCarteira = useCallback(async () => {
    try {
      const res = await api.get('/imoveis');
      setCarteira(res.data || []);
    } catch (error) {
      tratarErro(error, 'Não foi possível carregar sua carteira');
    }
  }, [tratarErro]);

  useEffect(() => {
    if (sessao && aba === 'carteira') carregarCarteira();
  }, [sessao, aba, carregarCarteira]);


  // Contador de tempo da busca. Espera de 40 segundos sem sinal nenhum parece travamento.
  useEffect(() => {
    if (!buscando && !atualizando) return undefined;
    setSegundos(0);
    const id = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [buscando, atualizando]);

  const salvarNaCarteira = async (e) => {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.post('/imoveis', formCarteira);
      setFormCarteira(FORM_CARTEIRA_INICIAL);
      setMostrarFormCarteira(false);
      aviso('Imóvel adicionado à carteira', 'sucesso');
      await carregarCarteira();
    } catch (error) {
      tratarErro(error, 'Não foi possível salvar');
    } finally {
      setSalvando(false);
    }
  };

  const removerDaCarteira = async (id) => {
    if (!window.confirm('Remover este imóvel da carteira?')) return;
    try {
      await api.delete(`/imoveis/${id}`);
      aviso('Imóvel removido', 'sucesso');
      await carregarCarteira();
    } catch (error) {
      tratarErro(error, 'Não foi possível remover');
    }
  };

  const analisarDaCarteira = async (id) => {
    const chave = `c${id}`;
    setAnalisando((a) => ({ ...a, [chave]: true }));
    try {
      const res = await api.post(`/imoveis/${id}/analisar`);
      setAnalises((a) => ({ ...a, [chave]: res.data }));
      carregarUso();
    } catch (error) {
      tratarErro(error, 'Não foi possível analisar');
    } finally {
      setAnalisando((a) => ({ ...a, [chave]: false }));
    }
  };

  const salvarPerfil = (e) => {
    e.preventDefault();
    gravarLocal(CHAVE_PERFIL, perfil);
    aviso('Perfil salvo neste navegador', 'sucesso');
  };

  const salvarImobiliaria = async (e) => {
    e.preventDefault();
    setSalvandoImobiliaria(true);
    try {
      const res = await api.put('/auth/perfil', { nome_imobiliaria: imobiliaria });
      // O nome vai dentro do token, então a sessão inteira é trocada.
      gravarLocal(CHAVE_SESSAO, res.data);
      setSessao(res.data);
      aviso('Imobiliária atualizada', 'sucesso');
    } catch (error) {
      tratarErro(error, 'Não foi possível salvar a imobiliária');
    } finally {
      setSalvandoImobiliaria(false);
    }
  };

  const salvarNotificacoes = async (e) => {
    e.preventDefault();
    setSalvandoNotif(true);
    try {
      const res = await api.put('/auth/notificacoes', {
        notificar_email: notificacoes.notificar_email,
        email_notificacao: notificacoes.email_notificacao || '',
      });
      setNotificacoes({ ...notificacoes, ...res.data });
      aviso('Aviso por email atualizado', 'sucesso');
    } catch (error) {
      tratarErro(error, 'Não foi possível salvar o aviso');
    } finally {
      setSalvandoNotif(false);
    }
  };

  // ===== Plano e equipe =====

  const carregarPlano = useCallback(async () => {
    try {
      const [cat, eq] = await Promise.all([api.get('/planos'), api.get('/equipe')]);
      setCatalogo(cat.data);
      setEquipe(eq.data);
    } catch (error) {
      if (error?.response?.status === 401) sair();
    }
  }, [sair]);

  const adicionarMembro = async (e) => {
    e.preventDefault();
    setSalvandoMembro(true);
    try {
      await api.post('/equipe', formMembro);
      setFormMembro({ nome: '', email: '', senha: '' });
      aviso('Corretor adicionado', 'sucesso');
      await carregarPlano();
    } catch (error) {
      tratarErro(error, 'Não foi possível adicionar');
    } finally {
      setSalvandoMembro(false);
    }
  };

  const removerMembro = async (id) => {
    if (!window.confirm('Remover este corretor? Ele perde o acesso.')) return;
    try {
      await api.delete(`/equipe/${id}`);
      await carregarPlano();
    } catch (error) {
      tratarErro(error, 'Não foi possível remover');
    }
  };

  const assinarPlano = async (planoId) => {
    try {
      await api.post('/assinatura/checkout', { plano: planoId });
    } catch (error) {
      // 501 é o esperado enquanto o pagamento não está ligado.
      aviso(mensagemDeErro(error, 'Pagamento ainda não conectado.'), 'erro');
    }
  };

  // ===== Alertas =====

  const carregarResumo = useCallback(async () => {
    try {
      const res = await api.get('/resumo');
      setResumo(res.data);
    } catch (error) {
      if (error?.response?.status === 401) sair();
    }
  }, [sair]);

  const carregarAlertas = useCallback(async () => {
    try {
      const res = await api.get('/alertas');
      setAlertas(res.data || []);
    } catch (error) {
      if (error?.response?.status === 401) sair();
    }
  }, [sair]);

  // Precisa ficar depois das funções que ele chama: const não sobe como function.
  useEffect(() => {
    if (!sessao) return;
    carregarSalvos();
    carregarHistorico();
    carregarAlertas();
    carregarResumo();
    setImobiliaria(sessao.usuario?.nome_imobiliaria || '');
  }, [sessao, carregarSalvos, carregarHistorico, carregarAlertas, carregarResumo]);

  const agendarBuscaAtual = async () => {
    if (!formBusca.bairro.trim()) {
      aviso('Preencha ao menos o bairro antes de agendar', 'erro');
      return;
    }
    const criterios = Object.fromEntries(
      Object.entries(formBusca).filter(([, v]) => String(v).trim() !== '')
    );
    try {
      await api.post('/alertas', { criterios, hora: 7 });
      aviso('Busca agendada. Roda todo dia às 07:00 enquanto estiver ativa.', 'sucesso');
      await carregarAlertas();
      setAba('alertas');
    } catch (error) {
      tratarErro(error, 'Não foi possível agendar');
    }
  };

  const alterarAlerta = async (id, mudancas) => {
    try {
      const res = await api.put(`/alertas/${id}`, mudancas);
      setAlertas((lista) => lista.map((a) => (a.id === id ? res.data : a)));
    } catch (error) {
      tratarErro(error, 'Não foi possível alterar o alerta');
    }
  };

  const removerAlerta = async (id) => {
    if (!window.confirm('Remover esta busca agendada?')) return;
    try {
      await api.delete(`/alertas/${id}`);
      setAlertas((lista) => lista.filter((a) => a.id !== id));
    } catch (error) {
      tratarErro(error, 'Não foi possível remover');
    }
  };

  const rodarAlertaAgora = async (id) => {
    setRodando((r) => ({ ...r, [id]: true }));
    try {
      const res = await api.post(`/alertas/${id}/rodar`);
      setAlertas((lista) => lista.map((a) => (a.id === id ? res.data : a)));
      carregarUso();
    } catch (error) {
      tratarErro(error, 'Não foi possível rodar agora');
    } finally {
      setRodando((r) => ({ ...r, [id]: false }));
    }
  };

  // Joga o resultado guardado do alerta na tela de busca, sem gastar nada.
  const verResultadoAlerta = (alerta) => {
    setFormBusca({ ...FORM_BUSCA_INICIAL, ...alerta.criterios });
    setResultados(alerta.ultimo_resultado);
    setInfoCache({ do_cache: true, buscado_em: alerta.ultima_execucao });
    setAnalises({});
    setContatoAberto(null);
    setAba('buscar');
  };

  const perfilPreenchido = Boolean(perfil.nome && perfil.telefone);

  const copiar = async (texto, rotulo, marcador) => {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(`${marcador}-${rotulo}`);
      setTimeout(() => setCopiado((m) => (m === `${marcador}-${rotulo}` ? null : m)), 2000);
    } catch {
      aviso('Seu navegador bloqueou a cópia automática', 'erro');
    }
  };

  const abrirContato = (anuncio, id) => {
    if (!perfilPreenchido) {
      aviso('Preencha seu perfil primeiro para agilizar o contato', 'erro');
      setAba('perfil');
      return;
    }
    setContatoAberto((atual) => (atual === id ? null : id));
    marcarAnuncio(anuncio, id, { status: 'contatado' });
    window.open(anuncio.link, '_blank', 'noopener');
  };

  // Reaproveita uma busca antiga: preenche o formulário e dispara de novo.
  const repetirBusca = (criterios) => {
    const alvo = { ...FORM_BUSCA_INICIAL, ...criterios };
    setFormBusca(alvo);
    setAba('buscar');
    executarBusca(false, alvo);
  };

  const totalNovos = alertas.reduce((soma, a) => soma + (a.novos ? a.novos.length : 0), 0);

  const pendencias = resumo
    ? resumo.total_novos + resumo.sem_resposta.length + resumo.parceria_parada.length
    : 0;

  const mudarStatusPendencia = async (registro, status) => {
    const anuncio = registro.dados || registro;
    await marcarAnuncio(anuncio, idDoAnuncio(registro, registro.id), { status: status || null });
    carregarResumo();
  };

  if (!sessao) return <Login aoEntrar={entrar} />;

  return (
    <div className="app">
      <header className="topo">
        <div className="topo-inner">
          <div className="marca">
            <span className="marca-icone">🏙️</span>
            <div>
              <h1>Radar Imobiliário</h1>
              <p>{sessao.usuario?.nome_imobiliaria}</p>
            </div>
            <div className="topo-direita">
              {uso ? <span className="cota">{uso.buscas_restantes} buscas no mês</span> : null}
              <button className="btn btn-texto" onClick={sair}>Sair</button>
            </div>
          </div>
          <nav className="abas">
            <button className={aba === 'dia' ? 'ativa' : ''} onClick={() => { setAba('dia'); carregarResumo(); }}>
              Meu dia{pendencias ? ` (${pendencias})` : ''}
            </button>
            <button className={aba === 'buscar' ? 'ativa' : ''} onClick={() => setAba('buscar')}>Buscar imóveis</button>
            <button className={aba === 'salvos' ? 'ativa' : ''} onClick={() => setAba('salvos')}>
              Salvos{Object.keys(salvos).length ? ` (${Object.keys(salvos).length})` : ''}
            </button>
            <button className={aba === 'alertas' ? 'ativa' : ''} onClick={() => setAba('alertas')}>
              Agendadas{totalNovos ? ` (${totalNovos} novos)` : ''}
            </button>
            <button className={aba === 'carteira' ? 'ativa' : ''} onClick={() => setAba('carteira')}>Minha carteira</button>
            <button className={aba === 'perfil' ? 'ativa' : ''} onClick={() => setAba('perfil')}>Meu perfil</button>
            <button className={aba === 'plano' ? 'ativa' : ''} onClick={() => { setAba('plano'); carregarPlano(); }}>Plano</button>
          </nav>
        </div>
      </header>

      {assinatura && assinatura.vencida ? (
        <div className="faixa-aviso faixa-grave">
          <div className="faixa-conteudo">
            <span className="faixa-texto">
              <strong>Assinatura vencida.</strong> Buscar e analisar estão bloqueados. Tudo que você
              já salvou continua aqui e volta assim que o plano for renovado.
            </span>
            <button className="btn btn-texto" onClick={() => { setAba('plano'); carregarPlano(); }}>Ver planos</button>
          </div>
        </div>
      ) : null}

      {/* Só na aba de agendadas: é o único lugar onde a falta do email muda alguma coisa. */}
      {notificacoes.email_ligado === false && aba === 'alertas' ? (
        <div className="faixa-aviso">
          <div className="faixa-conteudo">
            <span className="faixa-texto">
              <strong>Aviso por email não configurado.</strong> As buscas agendadas rodam e mostram os
              imóveis novos aqui dentro, mas ninguém recebe aviso fora do app enquanto o SMTP não for
              ligado no servidor.
            </span>
            <button className="btn btn-texto" onClick={() => setAba('perfil')}>Ver detalhes</button>
          </div>
        </div>
      ) : null}

      {mensagem ? <div className={`alerta alerta-${mensagem.tipo}`}>{mensagem.texto}</div> : null}

      <main className="conteudo">
        {aba === 'dia' ? (
          <>
            {resumo ? (
              <section className="painel painel-abertura">
                <p className="saudacao">{saudacao()}, {primeiroNome(sessao.usuario?.nome_imobiliaria)}</p>
                <p className="data-hoje">{dataPorExtenso()}</p>
                <p className="frase frase-dia">{FRASE}</p>

                <div className="tiles">
                  <div className="tile">
                    <span className="tile-numero">{resumo.total_novos}</span>
                    <span className="tile-rotulo">novos hoje</span>
                  </div>
                  <div className="tile">
                    <span className="tile-numero">{resumo.sem_resposta.length}</span>
                    <span className="tile-rotulo">sem resposta</span>
                  </div>
                  <div className="tile tile-bom">
                    <span className="tile-numero">{resumo.numeros.parcerias}</span>
                    <span className="tile-rotulo">parcerias aceitas</span>
                  </div>
                  <div className="tile">
                    <span className="tile-numero">{resumo.numeros.alertas_ativos_n}</span>
                    <span className="tile-rotulo">buscas ativas</span>
                  </div>
                </div>

                {resumo.numeros.salvos > 0 ? (
                  <div className="funil">
                    <p className="funil-titulo">Seu funil</p>
                    {[
                      ['Salvos', resumo.numeros.salvos, 'funil-1'],
                      ['Contatados', resumo.numeros.contatados, 'funil-2'],
                      ['Responderam', resumo.numeros.responderam, 'funil-3'],
                      ['Aceitaram parceria', resumo.numeros.parcerias, 'funil-4'],
                    ].map(([rotulo, valor, cls]) => (
                      <div className="funil-linha" key={rotulo}>
                        <span className="funil-rotulo">{rotulo}</span>
                        <div className="funil-barra">
                          <div
                            className={`funil-fill ${cls}`}
                            style={{ width: `${resumo.numeros.salvos ? Math.max(3, (valor / resumo.numeros.salvos) * 100) : 0}%` }}
                          />
                        </div>
                        <span className="funil-valor">{valor}</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {uso ? (
                  <p className="ajuda" style={{ marginBottom: 0, marginTop: 16 }}>
                    {uso.buscas_restantes} de {uso.buscas_limite} buscas restantes neste mês.
                  </p>
                ) : null}
              </section>
            ) : null}

            {!resumo ? (
              <section className="painel estado"><div className="spinner" /><p>Carregando seu dia.</p></section>
            ) : pendencias === 0 && resumo.favoritos_sem_contato.length === 0 ? (
              <section className="painel estado">
                <p>Nada pendente por aqui.</p>
                <p className="ajuda-espera">
                  {resumo.alertas_ativos > 0
                    ? `Você tem ${resumo.alertas_ativos} busca(s) agendada(s). Quando aparecer imóvel novo, ele cai aqui.`
                    : 'Agende uma busca para receber os imóveis novos nesta tela todo dia.'}
                </p>
              </section>
            ) : null}

            {resumo && resumo.novos_por_alerta.length > 0 ? (
              <section className="painel">
                <h2>Novos desde ontem</h2>
                <p className="ajuda">Apareceram nas suas buscas agendadas. Chegar primeiro é o que ganha a parceria.</p>
                {resumo.novos_por_alerta.map((al) => (
                  <div className="grupo-novos" key={al.id}>
                    <p className="grupo-titulo">{al.nome} · {al.novos.length} novo(s)</p>
                    {al.novos.slice(0, 6).map((a, i) => (
                      <div className="pendencia" key={a.link || i}>
                        <div className="pendencia-info">
                          <span className="pendencia-titulo">{a.titulo}</span>
                          <span className="pendencia-meta">
                            {formatarPrecoAnuncio(a)}
                            {a.site_origem ? ` · ${a.site_origem}` : ''}
                          </span>
                        </div>
                        <div className="pendencia-acoes">
                          {montarLinkWhatsApp(a.telefone, a.titulo) ? (
                            <a className="btn btn-zap" target="_blank" rel="noreferrer"
                              href={montarLinkWhatsApp(a.telefone, a.titulo)}>WhatsApp</a>
                          ) : a.link ? (
                            <a className="btn btn-secundario" href={a.link} target="_blank" rel="noreferrer">Abrir anúncio</a>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
                <button className="btn btn-texto" onClick={() => setAba('alertas')}>Ver buscas agendadas</button>
              </section>
            ) : null}

            {resumo && resumo.sem_resposta.length > 0 ? (
              <section className="painel">
                <h2>Sem resposta há {resumo.dias_sem_resposta} dias ou mais</h2>
                <p className="ajuda">Você contatou e ninguém voltou. Cobrar de novo costuma destravar.</p>
                {resumo.sem_resposta.map((r) => (
                  <ItemPendencia key={r.chave} registro={r} aoMudarStatus={(s) => mudarStatusPendencia(r, s)} />
                ))}
              </section>
            ) : null}

            {resumo && resumo.parceria_parada.length > 0 ? (
              <section className="painel">
                <h2>Parceria aceita e parada</h2>
                <p className="ajuda">
                  Aceitaram parceria há mais de {resumo.dias_parceria_parada} dias e nada andou.
                  É o que está mais perto de virar comissão.
                </p>
                {resumo.parceria_parada.map((r) => (
                  <ItemPendencia key={r.chave} registro={r} aoMudarStatus={(s) => mudarStatusPendencia(r, s)} />
                ))}
              </section>
            ) : null}

            {resumo && resumo.favoritos_sem_contato.length > 0 ? (
              <section className="painel">
                <h2>Favoritados e nunca contatados</h2>
                <p className="ajuda">Você marcou como interessante e parou aí.</p>
                {resumo.favoritos_sem_contato.map((r) => (
                  <ItemPendencia key={r.chave} registro={r} aoMudarStatus={(s) => mudarStatusPendencia(r, s)} />
                ))}
              </section>
            ) : null}
          </>
        ) : aba === 'buscar' ? (
          <>
            <section className="painel">
              <h2>O que você está procurando?</h2>
              <p className="ajuda">Só o bairro é obrigatório. Quanto mais campos preencher, mais precisa fica a busca.</p>

              <form onSubmit={(e) => { e.preventDefault(); executarBusca(false); }}>
                <div className="seletor-negocio" role="radiogroup" aria-label="Finalidade">
                  {[['venda', 'Comprar'], ['aluguel', 'Alugar']].map(([valor, rotulo]) => (
                    <button
                      type="button"
                      key={valor}
                      role="radio"
                      aria-checked={(formBusca.negocio || 'venda') === valor}
                      className={(formBusca.negocio || 'venda') === valor ? 'ativo' : ''}
                      onClick={() => setFormBusca({ ...formBusca, negocio: valor })}
                    >
                      {rotulo}
                    </button>
                  ))}
                </div>

                <div className="caixa-busca">
                  <input
                    className="campo-busca"
                    type="text"
                    autoComplete="off"
                    placeholder={formBusca.negocio === 'aluguel'
                      ? 'O que você procura para alugar?'
                      : 'O que você procura?'}
                    value={formBusca.consulta}
                    onChange={(e) => setFormBusca({ ...formBusca, consulta: e.target.value })}
                  />
                  <button type="submit" className="btn btn-principal btn-buscar" disabled={buscando || atualizando}>
                    {buscando || atualizando ? 'Buscando' : 'Buscar'}
                  </button>
                </div>

                {!formBusca.consulta && !resultados ? (
                  <div className="exemplos">
                    <span className="exemplos-rotulo">Tente</span>
                    {EXEMPLOS_BUSCA.map((ex) => (
                      <button type="button" className="chip" key={ex}
                        onClick={() => setFormBusca({ ...formBusca, consulta: ex })}>
                        {ex}
                      </button>
                    ))}
                  </div>
                ) : null}

                <button type="button" className="btn btn-texto alternar-filtros"
                  onClick={() => setMaisFiltros((v) => !v)}>
                  {maisFiltros ? 'Esconder filtros' : 'Mais filtros'}
                </button>

                <div className={maisFiltros ? 'filtros-avancados' : 'filtros-avancados escondido'}>
                <div className="grid grid-2">
                  <label>
                    <span>Bairro</span>
                    <input type="text" placeholder="Ex: Águas Claras" value={formBusca.bairro}
                      onChange={(e) => setFormBusca({ ...formBusca, bairro: e.target.value })} />
                  </label>
                  <label>
                    <span>Cidade</span>
                    <input type="text" placeholder="Ex: Brasília" value={formBusca.cidade}
                      onChange={(e) => setFormBusca({ ...formBusca, cidade: e.target.value })} />
                  </label>
                </div>

                <div className="grid grid-3">
                  <label>
                    <span>Tipo</span>
                    <select value={formBusca.tipo} onChange={(e) => setFormBusca({ ...formBusca, tipo: e.target.value })}>
                      <option value="">Qualquer</option>
                      <option value="apartamento">Apartamento</option>
                      <option value="casa">Casa</option>
                      <option value="terreno">Terreno</option>
                      <option value="comercial">Comercial</option>
                      <option value="sala comercial">Sala comercial</option>
                    </select>
                  </label>
                  <label>
                    <span>{formBusca.negocio === 'aluguel' ? 'Aluguel mínimo (mês)' : 'Preço mínimo'}</span>
                    <InputMoeda value={formBusca.preco_min}
                      onChange={(v) => setFormBusca({ ...formBusca, preco_min: v })} />
                  </label>
                  <label>
                    <span>{formBusca.negocio === 'aluguel' ? 'Aluguel máximo (mês)' : 'Preço máximo'}</span>
                    <InputMoeda value={formBusca.preco_max}
                      onChange={(v) => setFormBusca({ ...formBusca, preco_max: v })} />
                  </label>
                </div>

                <div className="grid grid-3">
                  <label>
                    <span>Quartos (mínimo)</span>
                    <input type="number" min="0" value={formBusca.quartos_min}
                      onChange={(e) => setFormBusca({ ...formBusca, quartos_min: e.target.value })} />
                  </label>
                  <label>
                    <span>Banheiros (mínimo)</span>
                    <input type="number" min="0" value={formBusca.banheiros_min}
                      onChange={(e) => setFormBusca({ ...formBusca, banheiros_min: e.target.value })} />
                  </label>
                  <label>
                    <span>Vagas (mínimo)</span>
                    <input type="number" min="0" value={formBusca.vagas_min}
                      onChange={(e) => setFormBusca({ ...formBusca, vagas_min: e.target.value })} />
                  </label>
                </div>

                <div className="grid grid-2">
                  <label>
                    <span>Área mínima (m²)</span>
                    <input type="number" min="0" value={formBusca.area_min}
                      onChange={(e) => setFormBusca({ ...formBusca, area_min: e.target.value })} />
                  </label>
                  <label>
                    <span>Área máxima (m²)</span>
                    <input type="number" min="0" value={formBusca.area_max}
                      onChange={(e) => setFormBusca({ ...formBusca, area_max: e.target.value })} />
                  </label>
                </div>

                <label className="campo-largo">
                  <span>Detalhes extras</span>
                  <textarea rows="3" placeholder="Ex: com piscina, perto do metrô, aceita animais, mobiliado"
                    value={formBusca.detalhes}
                    onChange={(e) => setFormBusca({ ...formBusca, detalhes: e.target.value })} />
                </label>

                </div>

                <div className="acoes-form">
                  <button type="button" className="btn btn-secundario" disabled={buscando || atualizando}
                    onClick={agendarBuscaAtual}>
                    Agendar esta busca
                  </button>
                  <button type="button" className="btn btn-texto" disabled={buscando || atualizando}
                    onClick={() => { setFormBusca(FORM_BUSCA_INICIAL); setResultados(null); setInfoCache(null); }}>
                    Limpar
                  </button>
                </div>
              </form>
            </section>

            {historico.length > 0 && !buscando ? (
              <section className="painel">
                <h2>Buscas recentes</h2>
                <p className="ajuda">Clique para repetir. Busca repetida nas últimas horas sai do cache, sem custo.</p>
                <div className="historico">
                  {historico.map((h) => (
                    <button key={h.id} className="chip" onClick={() => repetirBusca(h.criterios)}>
                      <span className="chip-texto">
                        {h.criterios.consulta || [
                          h.criterios.bairro,
                          h.criterios.cidade,
                          h.criterios.tipo,
                        ].filter(Boolean).join(' · ')}
                      </span>
                      <span className="chip-meta">{h.resultados} · {quandoFoi(h.criado_em)}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {buscando ? (
              <section className="painel estado">
                <div className="spinner" />
                <p>Procurando nos portais de imóveis.</p>
                <p className="contador">{segundos}s</p>
                <p className="previsao">{textoPrevisao(segundos, estimativa)}</p>
                <div className="barra barra-espera">
                  <div className="barra-fill"
                    style={{ width: `${Math.min(97, (segundos / (estimativa || 45)) * 100)}%` }} />
                </div>
                <p className="ajuda-espera">
                  Pode trocar de aba ou fechar esta tela: a busca continua rodando no servidor.
                  Repetir a mesma busca hoje é instantâneo.
                </p>
              </section>
            ) : null}

            {!buscando && resultados !== null ? (
              <section className="resultados">
                {atualizando ? (
                  <div className="faixa-atualizando">
                    <div className="spinner spinner-pequeno" />
                    <span>
                      Mostrando o resultado anterior. Procurando imóveis novos agora,
                      {' '}{segundos}s, {textoPrevisao(segundos, estimativa)}.
                    </span>
                  </div>
                ) : null}

                <div className="resultados-topo">
                  <h2>{resultados.length} {resultados.length === 1 ? 'imóvel encontrado' : 'imóveis encontrados'}</h2>
                  <div className="frescor">
                    {infoCache?.do_cache ? (
                      <>
                        <span className="capturado">Resultado salvo {quandoFoi(infoCache.buscado_em)}</span>
                        {!atualizando ? (
                          <button className="btn btn-texto" onClick={() => executarBusca(true)}>Buscar de novo</button>
                        ) : null}
                      </>
                    ) : (
                      <span className="capturado">Capturado agora, confirme disponibilidade com o anunciante</span>
                    )}
                  </div>
                </div>

                {resultados.length === 0 ? (
                  <div className="painel estado">
                    <p>Nenhum anúncio encontrado com esses critérios. Tente ampliar a faixa de preço ou remover alguns filtros.</p>
                  </div>
                ) : (
                  <div className="lista">
                    {resultados.map((anuncio, i) => {
                      const id = idDoAnuncio(anuncio, i);
                      return (
                        <CartaoResultado
                          key={id}
                          anuncio={anuncio}
                          analise={analises[id]}
                          analisando={Boolean(analisando[id])}
                          perfil={perfil}
                          perfilPreenchido={perfilPreenchido}
                          contatoAberto={contatoAberto === id}
                          copiado={copiado && copiado.startsWith(`${id}-`) ? copiado.slice(id.length + 1) : null}
                          salvo={salvos[id]}
                          aoAnalisar={() => analisarAnuncio(anuncio, id)}
                          aoAbrirContato={() => abrirContato(anuncio, id)}
                          aoCopiar={(texto, rotulo) => copiar(texto, rotulo, id)}
                          aoFavoritar={() => marcarAnuncio(anuncio, id, { favorito: !salvos[id]?.favorito })}
                          aoMarcarStatus={(status) => marcarAnuncio(anuncio, id, { status })}
                          aoContatar={() => marcarAnuncio(anuncio, id, { status: 'contatado' })}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            ) : null}
          </>
        ) : aba === 'salvos' ? (
          <>
            <section className="painel">
              <h2>Anúncios salvos</h2>
              <p className="ajuda">O que você favoritou e o que já contatou. Fica guardado mesmo depois que o anúncio sai do ar.</p>
              <div className="filtros-chips">
                {[
                  ['todos', 'Todos'],
                  ['favoritos', 'Favoritos'],
                  ['aceita_parceria', 'Aceita parceria'],
                  ['contatado', 'Contatados'],
                  ['sem_resposta', 'Sem resposta'],
                ].map(([valor, rotulo]) => (
                  <button
                    key={valor}
                    className={`chip chip-filtro ${filtroSalvos === valor ? 'chip-ativo' : ''}`}
                    onClick={() => setFiltroSalvos(valor)}
                  >
                    {rotulo}
                  </button>
                ))}
              </div>
            </section>

            <section className="resultados">
              {(() => {
                const lista = Object.entries(salvos).filter(([, r]) => {
                  if (filtroSalvos === 'todos') return true;
                  if (filtroSalvos === 'favoritos') return Boolean(r.favorito);
                  return r.status === filtroSalvos;
                });

                if (lista.length === 0) {
                  return (
                    <div className="painel estado">
                      <p>Nada aqui ainda. Favorite um anúncio na busca ou marque a situação depois de contatar.</p>
                    </div>
                  );
                }

                return (
                  <div className="lista">
                    {lista.map(([id, registro]) => {
                      const anuncio = registro.dados || registro;
                      return (
                        <article className={`card ${registro.status ? `card-${registro.status}` : ''}`} key={registro.chave}>
                          <div className="card-cabecalho">
                            <div>
                              <h3>{registro.titulo}</h3>
                              <p className="local">
                                {registro.bairro}
                                {registro.cidade ? `, ${registro.cidade}` : ''}
                              </p>
                            </div>
                            <div className="card-canto">
                              <button
                                className={`estrela ${registro.favorito ? 'estrela-ativa' : ''}`}
                                onClick={() => marcarAnuncio(anuncio, id, { favorito: !registro.favorito })}
                                aria-label="Favoritar"
                              >
                                {registro.favorito ? '★' : '☆'}
                              </button>
                              <span className="portal">{registro.site_origem}</span>
                            </div>
                          </div>

                          <p className="preco">{formatarPrecoAnuncio({ ...anuncio, preco: registro.preco })}</p>

                          <ControleStatus
                            salvo={registro}
                            aoMarcarStatus={(status) => marcarAnuncio(anuncio, id, { status })}
                          />

                          {registro.contatado_em ? (
                            <p className="marca-tempo">Contatado {quandoFoi(registro.contatado_em)}</p>
                          ) : null}

                          <div className="card-acoes">
                            {montarLinkWhatsApp(anuncio.telefone, registro.titulo) ? (
                              <a className="btn btn-zap" target="_blank" rel="noreferrer"
                                href={montarLinkWhatsApp(anuncio.telefone, registro.titulo)}>
                                Falar no WhatsApp
                              </a>
                            ) : null}
                            {registro.link ? (
                              <a className="btn btn-secundario" href={registro.link} target="_blank" rel="noreferrer">
                                Ver anúncio
                              </a>
                            ) : null}
                            <button className="btn btn-texto btn-perigo" onClick={() => removerSalvo(registro.chave, id)}>
                              Remover
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                );
              })()}
            </section>
          </>
        ) : aba === 'plano' ? (
          <>
            <section className="painel">
              <h2>Seu plano</h2>
              {!assinatura ? (
                <p className="ajuda">Carregando.</p>
              ) : (
                <>
                  <div className="plano-atual">
                    <div>
                      <p className="plano-nome">{assinatura.plano_nome}</p>
                      <p className="ajuda" style={{ marginBottom: 0 }}>
                        {assinatura.status === 'teste' ? 'Período de teste' : null}
                        {assinatura.status === 'ativa' ? 'Assinatura ativa' : null}
                        {assinatura.vencida ? 'Vencida' : null}
                        {assinatura.expira_em ? ` · até ${formatarData(assinatura.expira_em)}` : ''}
                      </p>
                    </div>
                  </div>

                  {uso ? (
                    <>
                      <div className="medidor">
                        <div className="medidor-topo">
                          <span>Buscas no mês</span>
                          <span>{uso.buscas} de {uso.buscas_limite}</span>
                        </div>
                        <div className="barra">
                          <div className="barra-fill" style={{ width: `${Math.min(100, (uso.buscas / uso.buscas_limite) * 100)}%` }} />
                        </div>
                      </div>
                      <div className="medidor">
                        <div className="medidor-topo">
                          <span>Análises no mês</span>
                          <span>{uso.analises} de {uso.analises_limite}</span>
                        </div>
                        <div className="barra">
                          <div className="barra-fill" style={{ width: `${Math.min(100, (uso.analises / uso.analises_limite) * 100)}%` }} />
                        </div>
                      </div>
                      <p className="ajuda">A cota volta a zerar no dia 1. Resultado que vem do cache não consome nada.</p>
                    </>
                  ) : null}
                </>
              )}
            </section>

            {catalogo ? (
              <section className="painel">
                <h2>Planos</h2>
                <p className="ajuda">
                  {catalogo.pagamento_ligado
                    ? 'Escolha o plano e siga para o pagamento.'
                    : 'O pagamento ainda não está conectado. Os limites já valem; a cobrança entra depois.'}
                </p>
                <div className="planos-grade">
                  {catalogo.planos.map((p) => (
                    <div className={`plano-card ${assinatura && assinatura.plano === p.id ? 'plano-card-atual' : ''}`} key={p.id}>
                      <p className="plano-card-nome">{p.nome}</p>
                      <p className="plano-card-preco">
                        {p.preco === 0 ? 'Grátis' : `R$ ${p.preco.toLocaleString('pt-BR')}`}
                        {p.preco > 0 ? <span className="plano-card-mes">/mês</span> : null}
                      </p>
                      <p className="plano-card-desc">{p.descricao}</p>
                      <ul className="plano-lista">
                        <li>{p.buscas_mes} buscas por mês</li>
                        <li>{p.analises_mes} análises de preço</li>
                        <li>{p.alertas} busca(s) agendada(s)</li>
                        <li>{p.contas} conta(s) de corretor</li>
                      </ul>
                      {assinatura && assinatura.plano === p.id ? (
                        <span className="plano-selo">Plano atual</span>
                      ) : p.preco > 0 ? (
                        <button className="btn btn-principal btn-bloco" onClick={() => assinarPlano(p.id)}>
                          Assinar
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {equipe ? (
              <section className="painel">
                <h2>Corretores da conta</h2>
                <p className="ajuda">
                  {equipe.usadas} de {equipe.limite_contas} conta(s) em uso. Todos compartilham a mesma
                  cota mensal e a mesma carteira.
                </p>

                {equipe.membros.length > 0 ? (
                  <div className="lista-membros">
                    {equipe.membros.map((m) => (
                      <div className="pendencia" key={m.id}>
                        <div className="pendencia-info">
                          <span className="pendencia-titulo">{m.nome_imobiliaria}</span>
                          <span className="pendencia-meta">{m.email}</span>
                        </div>
                        {equipe.eh_dono ? (
                          <div className="pendencia-acoes">
                            <button className="btn btn-texto btn-perigo" onClick={() => removerMembro(m.id)}>Remover</button>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="ajuda">Nenhum corretor adicionado além de você.</p>
                )}

                {equipe.eh_dono && equipe.usadas < equipe.limite_contas ? (
                  <form onSubmit={adicionarMembro} className="form-carteira">
                    <div className="grid grid-2">
                      <label>
                        <span>Nome do corretor</span>
                        <input type="text" value={formMembro.nome}
                          onChange={(e) => setFormMembro({ ...formMembro, nome: e.target.value })} required />
                      </label>
                      <label>
                        <span>Email</span>
                        <input type="email" value={formMembro.email}
                          onChange={(e) => setFormMembro({ ...formMembro, email: e.target.value })} required />
                      </label>
                    </div>
                    <label className="campo-largo">
                      <span>Senha provisória</span>
                      <input type="text" value={formMembro.senha}
                        onChange={(e) => setFormMembro({ ...formMembro, senha: e.target.value })}
                        placeholder="mínimo 8 caracteres" required />
                    </label>
                    <button type="submit" className="btn btn-principal" disabled={salvandoMembro}>
                      {salvandoMembro ? 'Adicionando...' : 'Adicionar corretor'}
                    </button>
                  </form>
                ) : null}

                {equipe.eh_dono && equipe.usadas >= equipe.limite_contas ? (
                  <p className="ajuda">Limite de contas do plano atingido. Mude de plano para adicionar mais corretores.</p>
                ) : null}
              </section>
            ) : null}
          </>
        ) : aba === 'perfil' ? (
          <>
          <section className="painel">
            <h2>Imobiliária</h2>
            <p className="ajuda">
              Fica salvo na sua conta, não só neste navegador. Trocar aqui não apaga nada:
              carteira, salvos e alertas continuam seus.
            </p>
            <form onSubmit={salvarImobiliaria}>
              <label className="campo-largo">
                <span>Nome da imobiliária</span>
                <input
                  type="text"
                  value={imobiliaria}
                  onChange={(e) => setImobiliaria(e.target.value)}
                  placeholder="Ex: Aguiar de Vasconcelos"
                  required
                />
              </label>
              <button type="submit" className="btn btn-principal" disabled={salvandoImobiliaria}>
                {salvandoImobiliaria ? 'Salvando...' : 'Salvar imobiliária'}
              </button>
            </form>
          </section>

          <section className="painel">
            <h2>Aviso de imóvel novo</h2>
            <p className="ajuda">
              Quando uma busca agendada encontrar imóvel novo, você recebe um email com a lista e os links.
              Só avisa quando tem novidade de verdade — a primeira execução nunca dispara aviso.
            </p>

            {notificacoes.email_ligado === false ? (
              <div className="alerta alerta-info" style={{ margin: '0 0 16px' }}>
                O envio de email ainda não está configurado no servidor. Falta definir as variáveis
                <strong> SMTP_HOST</strong>, <strong>SMTP_PORT</strong>, <strong>SMTP_USER</strong>,
                <strong> SMTP_PASS</strong> e <strong>SMTP_FROM</strong> no Railway, usando uma conta
                de email do domínio na Hostinger. A preferência abaixo fica salva e passa a valer
                assim que isso for feito.
              </div>
            ) : null}

            <form onSubmit={salvarNotificacoes}>
              <label className="interruptor" style={{ marginBottom: 16 }}>
                <input
                  type="checkbox"
                  checked={notificacoes.notificar_email}
                  onChange={(e) => setNotificacoes({ ...notificacoes, notificar_email: e.target.checked })}
                />
                <span>{notificacoes.notificar_email ? 'Avisar por email' : 'Não avisar'}</span>
              </label>

              <label className="campo-largo">
                <span>Email para aviso</span>
                <input
                  type="email"
                  placeholder={sessao.usuario?.email || 'seu@email.com'}
                  value={notificacoes.email_notificacao || ''}
                  onChange={(e) => setNotificacoes({ ...notificacoes, email_notificacao: e.target.value })}
                />
              </label>
              <p className="ajuda">Deixe em branco para receber no email da conta.</p>

              <button type="submit" className="btn btn-principal" disabled={salvandoNotif}>
                {salvandoNotif ? 'Salvando...' : 'Salvar aviso'}
              </button>
            </form>
          </section>

          <section className="painel">
            <h2>Meu perfil</h2>
            <p className="ajuda">
              Esses dados ficam salvos só neste navegador e são usados para agilizar o preenchimento
              dos formulários de contato dos portais.
            </p>

            <form onSubmit={salvarPerfil}>
              <div className="grid grid-2">
                <label>
                  <span>Nome <em>obrigatório</em></span>
                  <input type="text" placeholder="Como aparece para o anunciante" value={perfil.nome}
                    onChange={(e) => setPerfil({ ...perfil, nome: e.target.value })} required />
                </label>
                <label>
                  <span>Telefone <em>obrigatório</em></span>
                  <input type="tel" placeholder="(61) 90000-0000" value={perfil.telefone}
                    onChange={(e) => setPerfil({ ...perfil, telefone: e.target.value })} required />
                </label>
              </div>

              <label className="campo-largo">
                <span>Email</span>
                <input type="email" placeholder="seu@email.com" value={perfil.email}
                  onChange={(e) => setPerfil({ ...perfil, email: e.target.value })} />
              </label>

              <label className="campo-largo">
                <span>Mensagem padrão</span>
                <textarea rows="4" value={perfil.mensagem}
                  onChange={(e) => setPerfil({ ...perfil, mensagem: e.target.value })} />
              </label>

              <button type="submit" className="btn btn-principal">Salvar perfil</button>
            </form>
          </section>
          </>
        ) : aba === 'alertas' ? (
          <>
            <section className="painel">
              <h2>Buscas agendadas</h2>
              <p className="ajuda">
                Cada alerta é uma busca sua que roda uma vez por dia, no horário que você escolher,
                e compara com o resultado do dia anterior para mostrar o que apareceu de novo.
                Alerta desativado não roda e não gasta nada.
              </p>
              <p className="ajuda">
                Para criar: monte a busca na aba <strong>Buscar imóveis</strong> e clique em
                "Agendar esta busca". Seu limite é de {LIMITE_ALERTAS_VISIVEL} alertas.
              </p>
            </section>

            <section className="resultados">
              {alertas.length === 0 ? (
                <div className="painel estado">
                  <p>Nenhuma busca agendada ainda.</p>
                </div>
              ) : (
                <div className="lista-alertas">
                  {alertas.map((al) => (
                    <article className={`painel alerta-card ${al.ativo ? '' : 'alerta-inativo'}`} key={al.id}>
                      <div className="alerta-topo">
                        <div>
                          <h3>{al.nome}</h3>
                          <p className="alerta-criterios">{resumoCriterios(al.criterios)}</p>
                        </div>
                        <label className="interruptor">
                          <input
                            type="checkbox"
                            checked={al.ativo}
                            onChange={(e) => alterarAlerta(al.id, { ativo: e.target.checked })}
                          />
                          <span>{al.ativo ? 'Ativo' : 'Pausado'}</span>
                        </label>
                      </div>

                      <div className="alerta-linha">
                        <label className="alerta-hora">
                          <span>Roda às</span>
                          <select
                            className="status-select"
                            value={al.hora}
                            onChange={(e) => alterarAlerta(al.id, { hora: Number(e.target.value) })}
                          >
                            {Array.from({ length: 24 }, (_, h) => (
                              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                            ))}
                          </select>
                        </label>
                        <span className="marca-tempo">
                          {al.ultima_execucao ? `Última vez ${quandoFoi(al.ultima_execucao)}` : 'Ainda não rodou'}
                        </span>
                      </div>

                      {al.erro ? <p className="alerta-erro-txt">Última tentativa falhou: {al.erro}</p> : null}

                      {al.novos.length > 0 ? (
                        <div className="bloco-novos">
                          <p className="bloco-titulo">{al.novos.length} novo(s) desde a última vez</p>
                          {al.novos.slice(0, 5).map((a, i) => (
                            <div className="novo-item" key={a.link || i}>
                              <span className="novo-titulo">{a.titulo}</span>
                              <span className="novo-preco">{formatarPrecoAnuncio(a)}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {al.sumidos.length > 0 ? (
                        <p className="marca-tempo">
                          {al.sumidos.length} anúncio(s) sumiram do portal desde a última vez.
                          Costuma ser venda fechada ou anúncio retirado.
                        </p>
                      ) : null}

                      <div className="card-acoes">
                        <button
                          className="btn btn-secundario"
                          onClick={() => rodarAlertaAgora(al.id)}
                          disabled={rodando[al.id]}
                        >
                          {rodando[al.id] ? 'Rodando...' : 'Rodar agora'}
                        </button>
                        {al.ultimo_resultado.length > 0 ? (
                          <button className="btn btn-texto" onClick={() => verResultadoAlerta(al)}>
                            Ver {al.ultimo_resultado.length} resultado(s)
                          </button>
                        ) : null}
                        <button className="btn btn-texto btn-perigo" onClick={() => removerAlerta(al.id)}>
                          Remover
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <section className="painel">
              <div className="carteira-topo">
                <div>
                  <h2>Minha carteira</h2>
                  <p className="ajuda">Os imóveis que você representa. Em breve conectamos direto com a API da imobiliária.</p>
                </div>
                <button className="btn btn-principal" onClick={() => setMostrarFormCarteira((v) => !v)}>
                  {mostrarFormCarteira ? 'Cancelar' : 'Adicionar imóvel'}
                </button>
              </div>

              {mostrarFormCarteira ? (
                <form onSubmit={salvarNaCarteira} className="form-carteira">
                  <div className="grid grid-2">
                    <label>
                      <span>Título <em>obrigatório</em></span>
                      <input type="text" value={formCarteira.titulo}
                        onChange={(e) => setFormCarteira({ ...formCarteira, titulo: e.target.value })} required />
                    </label>
                    <label>
                      <span>Preço <em>obrigatório</em></span>
                      <InputMoeda value={formCarteira.preco}
                        onChange={(v) => setFormCarteira({ ...formCarteira, preco: v })} />
                    </label>
                  </div>

                  <div className="grid grid-2">
                    <label>
                      <span>Bairro <em>obrigatório</em></span>
                      <input type="text" value={formCarteira.bairro}
                        onChange={(e) => setFormCarteira({ ...formCarteira, bairro: e.target.value })} required />
                    </label>
                    <label>
                      <span>Tipo</span>
                      <select value={formCarteira.tipo}
                        onChange={(e) => setFormCarteira({ ...formCarteira, tipo: e.target.value })}>
                        <option value="apartamento">Apartamento</option>
                        <option value="casa">Casa</option>
                        <option value="terreno">Terreno</option>
                        <option value="comercial">Comercial</option>
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-3">
                    <label>
                      <span>Quartos</span>
                      <input type="number" value={formCarteira.quartos}
                        onChange={(e) => setFormCarteira({ ...formCarteira, quartos: e.target.value })} />
                    </label>
                    <label>
                      <span>Banheiros</span>
                      <input type="number" value={formCarteira.banheiros}
                        onChange={(e) => setFormCarteira({ ...formCarteira, banheiros: e.target.value })} />
                    </label>
                    <label>
                      <span>Área (m²)</span>
                      <input type="number" value={formCarteira.area_m2}
                        onChange={(e) => setFormCarteira({ ...formCarteira, area_m2: e.target.value })} />
                    </label>
                  </div>

                  <label className="campo-largo">
                    <span>Descrição</span>
                    <textarea rows="3" value={formCarteira.descricao}
                      onChange={(e) => setFormCarteira({ ...formCarteira, descricao: e.target.value })} />
                  </label>

                  <div className="grid grid-2">
                    <label>
                      <span>Telefone de contato</span>
                      <input type="tel" value={formCarteira.contato_telefone}
                        onChange={(e) => setFormCarteira({ ...formCarteira, contato_telefone: e.target.value })} />
                    </label>
                    <label>
                      <span>Email de contato</span>
                      <input type="email" value={formCarteira.contato_email}
                        onChange={(e) => setFormCarteira({ ...formCarteira, contato_email: e.target.value })} />
                    </label>
                  </div>

                  <button type="submit" className="btn btn-principal" disabled={salvando}>
                    {salvando ? 'Salvando...' : 'Salvar na carteira'}
                  </button>
                </form>
              ) : null}
            </section>

            <section className="resultados">
              {carteira.length === 0 ? (
                <div className="painel estado">
                  <p>Sua carteira está vazia. Adicione os imóveis que você representa.</p>
                </div>
              ) : (
                <div className="lista">
                  {carteira.map((im) => (
                    <article className="card" key={im.id}>
                      <div className="card-cabecalho">
                        <div>
                          <h3>{im.titulo}</h3>
                          <p className="local">{im.bairro}{im.tipo ? ` · ${im.tipo}` : ''}</p>
                        </div>
                      </div>

                      <p className="preco">{formatarPreco(im.preco)}</p>

                      <ul className="specs">
                        {im.quartos ? <li>{im.quartos} quartos</li> : null}
                        {im.banheiros ? <li>{im.banheiros} banheiros</li> : null}
                        {im.area_m2 ? <li>{Number(im.area_m2)} m²</li> : null}
                      </ul>

                      {im.descricao ? <p className="descricao">{im.descricao}</p> : null}

                      {im.contato_telefone || im.contato_email ? (
                        <p className="contato">
                          {im.contato_telefone ? im.contato_telefone : ''}
                          {im.contato_telefone && im.contato_email ? ' · ' : ''}
                          {im.contato_email ? im.contato_email : ''}
                        </p>
                      ) : null}

                      {analises[`c${im.id}`] ? <BlocoAnalise dados={analises[`c${im.id}`]} /> : null}

                      <div className="card-acoes">
                        <button className="btn btn-secundario" onClick={() => analisarDaCarteira(im.id)}
                          disabled={analisando[`c${im.id}`]}>
                          {analisando[`c${im.id}`] ? 'Analisando...' : 'Analisar preço com IA'}
                        </button>
                        <button className="btn btn-texto btn-perigo" onClick={() => removerDaCarteira(im.id)}>
                          Remover
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      <footer className="rodape">
        <p>Radar Imobiliário · dados capturados de portais públicos, sempre confirme disponibilidade com o anunciante</p>
      </footer>

      {/* Fica visível em qualquer aba: a busca roda no servidor, não nesta tela. */}
      {buscando || atualizando ? (
        <button
          className="indicador-busca"
          onClick={() => setAba('buscar')}
          title="Ver a busca em andamento"
        >
          <span className="spinner spinner-pequeno" />
          <span className="indicador-texto">
            <strong>Procurando imóveis</strong>
            <span>{segundos}s · {textoPrevisao(segundos, estimativa)}</span>
          </span>
        </button>
      ) : null}
    </div>
  );
}

export default App;
