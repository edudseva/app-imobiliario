import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

const API_BASE = 'https://app-imobiliario-production.up.railway.app/api';

const formatarPreco = (valor) => {
  if (valor === null || valor === undefined || valor === '') return 'Preço não informado';
  return Number(valor).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
};

const montarLinkWhatsApp = (telefone, titulo) => {
  if (!telefone) return null;
  let numero = String(telefone).replace(/\D/g, '');
  if (numero.length < 10) return null;
  if (!numero.startsWith('55')) numero = '55' + numero;
  const msg = `Olá, vi o anúncio do imóvel "${titulo}". Ainda está disponível? Vocês trabalham com parceria entre corretores?`;
  return `https://wa.me/${numero}?text=${encodeURIComponent(msg)}`;
};

const FORM_BUSCA_INICIAL = {
  cidade: '',
  bairro: '',
  tipo: '',
  preco_min: '',
  preco_max: '',
  quartos_min: '',
  banheiros_min: '',
  vagas_min: '',
  area_min: '',
  area_max: '',
  detalhes: '',
};

const FORM_CARTEIRA_INICIAL = {
  titulo: '',
  preco: '',
  bairro: '',
  tipo: 'apartamento',
  quartos: '',
  banheiros: '',
  area_m2: '',
  descricao: '',
  contato_telefone: '',
  contato_email: '',
};

function App() {
  const [aba, setAba] = useState('buscar');
  const [mensagem, setMensagem] = useState(null);

  const [formBusca, setFormBusca] = useState(FORM_BUSCA_INICIAL);
  const [buscando, setBuscando] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [analises, setAnalises] = useState({});
  const [analisando, setAnalisando] = useState({});

  const [carteira, setCarteira] = useState([]);
  const [formCarteira, setFormCarteira] = useState(FORM_CARTEIRA_INICIAL);
  const [salvando, setSalvando] = useState(false);
  const [mostrarFormCarteira, setMostrarFormCarteira] = useState(false);

    const aviso = (texto, tipo = 'info') => {
    setMensagem({ texto, tipo });
    if (tipo !== 'erro') setTimeout(() => setMensagem(null), 5000);
  };

  const buscarAnuncios = async (e) => {
    e.preventDefault();
    if (!formBusca.bairro.trim()) {
      aviso('Informe pelo menos o bairro para buscar', 'erro');
      return;
    }
    setBuscando(true);
    setResultados(null);
    setAnalises({});
    try {
      const payload = Object.fromEntries(
        Object.entries(formBusca).filter(([, v]) => String(v).trim() !== '')
      );
      const res = await axios.post(`${API_BASE}/buscar-anuncios`, payload);
      setResultados(res.data.anuncios || []);
    } catch (error) {
      aviso(error.response?.data?.erro || 'Não foi possível concluir a busca agora', 'erro');
      setResultados([]);
    } finally {
      setBuscando(false);
    }
  };

  const analisarAnuncio = async (anuncio, indice) => {
    setAnalisando((a) => ({ ...a, [indice]: true }));
    try {
      const res = await axios.post(`${API_BASE}/analisar-avulso`, {
        titulo: anuncio.titulo,
        preco: anuncio.preco,
        bairro: anuncio.bairro,
        tipo: anuncio.tipo,
        quartos: anuncio.quartos,
        banheiros: anuncio.banheiros,
        area_m2: anuncio.area_m2,
        descricao: `${anuncio.tipo || ''} em ${anuncio.bairro || ''}${anuncio.cidade ? ', ' + anuncio.cidade : ''}`,
      });
      setAnalises((a) => ({ ...a, [indice]: res.data }));
    } catch (error) {
      aviso(error.response?.data?.erro || 'Não foi possível analisar este imóvel', 'erro');
    } finally {
      setAnalisando((a) => ({ ...a, [indice]: false }));
    }
  };

  const carregarCarteira = async () => {
    try {
      const res = await axios.get(`${API_BASE}/imoveis`);
      setCarteira(res.data || []);
    } catch (error) {
      aviso('Não foi possível carregar sua carteira', 'erro');
    }
  };

  const salvarNaCarteira = async (e) => {
    e.preventDefault();
    setSalvando(true);
    try {
      await axios.post(`${API_BASE}/imoveis`, formCarteira);
      setFormCarteira(FORM_CARTEIRA_INICIAL);
      setMostrarFormCarteira(false);
      aviso('Imóvel adicionado à carteira', 'sucesso');
      await carregarCarteira();
    } catch (error) {
      aviso(error.response?.data?.erro || 'Não foi possível salvar', 'erro');
    } finally {
      setSalvando(false);
    }
  };

  const removerDaCarteira = async (id) => {
    if (!window.confirm('Remover este imóvel da carteira?')) return;
    try {
      await axios.delete(`${API_BASE}/imoveis/${id}`);
      aviso('Imóvel removido', 'sucesso');
      await carregarCarteira();
    } catch (error) {
      aviso('Não foi possível remover', 'erro');
    }
  };

  const analisarDaCarteira = async (id) => {
    setAnalisando((a) => ({ ...a, [`c${id}`]: true }));
    try {
      const res = await axios.post(`${API_BASE}/imoveis/${id}/analisar`);
      setAnalises((a) => ({ ...a, [`c${id}`]: res.data }));
    } catch (error) {
      aviso(error.response?.data?.erro || 'Não foi possível analisar', 'erro');
    } finally {
      setAnalisando((a) => ({ ...a, [`c${id}`]: false }));
    }
  };

  useEffect(() => {
    if (aba === 'carteira') carregarCarteira();
  }, [aba]);

  const BlocoAnalise = ({ dados }) => (
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
      </div>
    </div>
  );

  return (
    <div className="app">
      <header className="topo">
        <div className="topo-inner">
          <div className="marca">
            <span className="marca-icone">🏙️</span>
            <div>
              <h1>Radar Imobiliário</h1>
              <p>Encontre imóveis em vários portais e já abra a conversa de parceria</p>
            </div>
          </div>
          <nav className="abas">
            <button className={aba === 'buscar' ? 'ativa' : ''} onClick={() => setAba('buscar')}>
              Buscar imóveis
            </button>
            <button className={aba === 'carteira' ? 'ativa' : ''} onClick={() => setAba('carteira')}>
              Minha carteira
            </button>
          </nav>
        </div>
      </header>

      {mensagem ? <div className={`alerta alerta-${mensagem.tipo}`}>{mensagem.texto}</div> : null}

      <main className="conteudo">
        {aba === 'buscar' ? (
          <>
            <section className="painel">
              <h2>O que você está procurando?</h2>
              <p className="ajuda">Só o bairro é obrigatório. Quanto mais campos preencher, mais precisa fica a busca.</p>

              <form onSubmit={buscarAnuncios}>
                <div className="grid grid-2">
                  <label>
                    <span>Bairro <em>obrigatório</em></span>
                    <input
                      type="text"
                      placeholder="Ex: Águas Claras"
                      value={formBusca.bairro}
                      onChange={(e) => setFormBusca({ ...formBusca, bairro: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Cidade</span>
                    <input
                      type="text"
                      placeholder="Ex: Brasília"
                      value={formBusca.cidade}
                      onChange={(e) => setFormBusca({ ...formBusca, cidade: e.target.value })}
                    />
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
                    <span>Preço mínimo</span>
                    <input
                      type="number"
                      placeholder="R$"
                      value={formBusca.preco_min}
                      onChange={(e) => setFormBusca({ ...formBusca, preco_min: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Preço máximo</span>
                    <input
                      type="number"
                      placeholder="R$"
                      value={formBusca.preco_max}
                      onChange={(e) => setFormBusca({ ...formBusca, preco_max: e.target.value })}
                    />
                  </label>
                </div>

                <div className="grid grid-3">
                  <label>
                    <span>Quartos (mínimo)</span>
                    <input
                      type="number"
                      min="0"
                      value={formBusca.quartos_min}
                      onChange={(e) => setFormBusca({ ...formBusca, quartos_min: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Banheiros (mínimo)</span>
                    <input
                      type="number"
                      min="0"
                      value={formBusca.banheiros_min}
                      onChange={(e) => setFormBusca({ ...formBusca, banheiros_min: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Vagas (mínimo)</span>
                    <input
                      type="number"
                      min="0"
                      value={formBusca.vagas_min}
                      onChange={(e) => setFormBusca({ ...formBusca, vagas_min: e.target.value })}
                    />
                  </label>
                </div>

                <div className="grid grid-2">
                  <label>
                    <span>Área mínima (m²)</span>
                    <input
                      type="number"
                      min="0"
                      value={formBusca.area_min}
                      onChange={(e) => setFormBusca({ ...formBusca, area_min: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>Área máxima (m²)</span>
                    <input
                      type="number"
                      min="0"
                      value={formBusca.area_max}
                      onChange={(e) => setFormBusca({ ...formBusca, area_max: e.target.value })}
                    />
                  </label>
                </div>

                <label className="campo-largo">
                  <span>Detalhes extras</span>
                  <textarea
                    rows="3"
                    placeholder="Ex: com piscina, perto do metrô, aceita animais, mobiliado, aceita financiamento"
                    value={formBusca.detalhes}
                    onChange={(e) => setFormBusca({ ...formBusca, detalhes: e.target.value })}
                  />
                </label>

                <div className="acoes-form">
                  <button type="submit" className="btn btn-principal" disabled={buscando}>
                    {buscando ? 'Buscando nos portais...' : 'Buscar imóveis'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-texto"
                    onClick={() => { setFormBusca(FORM_BUSCA_INICIAL); setResultados(null); }}
                    disabled={buscando}
                  >
                    Limpar campos
                  </button>
                </div>
              </form>
            </section>

            {buscando ? (
              <section className="painel estado">
                <div className="spinner" />
                <p>Consultando OLX, Viva Real, Zap, Imovelweb e QuintoAndar. Isso leva alguns segundos.</p>
              </section>
            ) : null}

            {!buscando && resultados !== null ? (
              <section className="resultados">
                <div className="resultados-topo">
                  <h2>{resultados.length} {resultados.length === 1 ? 'imóvel encontrado' : 'imóveis encontrados'}</h2>
                  <span className="capturado">Capturado agora, confirme disponibilidade com o anunciante</span>
                </div>

                {resultados.length === 0 ? (
                  <div className="painel estado">
                    <p>Nenhum anúncio encontrado com esses critérios. Tente ampliar a faixa de preço ou remover alguns filtros.</p>
                  </div>
                ) : (
                  <div className="lista">
                    {resultados.map((anuncio, i) => {
                      const link = montarLinkWhatsApp(anuncio.telefone, anuncio.titulo);
                      return (
                        <article className="card" key={i}>
                          <div className="card-cabecalho">
                            <div>
                              <h3>{anuncio.titulo}</h3>
                              <p className="local">
                                {anuncio.bairro}
                                {anuncio.cidade ? `, ${anuncio.cidade}` : ''}
                                {anuncio.tipo ? ` · ${anuncio.tipo}` : ''}
                              </p>
                            </div>
                            <span className="portal">{anuncio.site_origem}</span>
                          </div>

                          <p className="preco">{formatarPreco(anuncio.preco)}</p>

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

                          {analises[i] ? <BlocoAnalise dados={analises[i]} /> : null}

                          <div className="card-acoes">
                            {link ? (
                              <a className="btn btn-zap" href={link} target="_blank" rel="noreferrer">
                                Falar no WhatsApp
                              </a>
                            ) : anuncio.link ? (
                              <a className="btn btn-principal" href={anuncio.link} target="_blank" rel="noreferrer">
                                Abrir anúncio original
                              </a>
                            ) : null}

                            {link && anuncio.link ? (
                              <a className="btn btn-secundario" href={anuncio.link} target="_blank" rel="noreferrer">
                                Ver anúncio
                              </a>
                            ) : null}

                            <button
                              className="btn btn-texto"
                              onClick={() => analisarAnuncio(anuncio, i)}
                              disabled={analisando[i]}
                            >
                              {analisando[i] ? 'Analisando...' : analises[i] ? 'Analisar de novo' : 'Analisar preço com IA'}
                            </button>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : null}
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
                      <input
                        type="text"
                        value={formCarteira.titulo}
                        onChange={(e) => setFormCarteira({ ...formCarteira, titulo: e.target.value })}
                        required
                      />
                    </label>
                    <label>
                      <span>Preço <em>obrigatório</em></span>
                      <input
                        type="number"
                        value={formCarteira.preco}
                        onChange={(e) => setFormCarteira({ ...formCarteira, preco: e.target.value })}
                        required
                      />
                    </label>
                  </div>

                  <div className="grid grid-2">
                    <label>
                      <span>Bairro <em>obrigatório</em></span>
                      <input
                        type="text"
                        value={formCarteira.bairro}
                        onChange={(e) => setFormCarteira({ ...formCarteira, bairro: e.target.value })}
                        required
                      />
                    </label>
                    <label>
                      <span>Tipo</span>
                      <select
                        value={formCarteira.tipo}
                        onChange={(e) => setFormCarteira({ ...formCarteira, tipo: e.target.value })}
                      >
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
                      <input
                        type="number"
                        value={formCarteira.quartos}
                        onChange={(e) => setFormCarteira({ ...formCarteira, quartos: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>Banheiros</span>
                      <input
                        type="number"
                        value={formCarteira.banheiros}
                        onChange={(e) => setFormCarteira({ ...formCarteira, banheiros: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>Área (m²)</span>
                      <input
                        type="number"
                        value={formCarteira.area_m2}
                        onChange={(e) => setFormCarteira({ ...formCarteira, area_m2: e.target.value })}
                      />
                    </label>
                  </div>

                  <label className="campo-largo">
                    <span>Descrição</span>
                    <textarea
                      rows="3"
                      value={formCarteira.descricao}
                      onChange={(e) => setFormCarteira({ ...formCarteira, descricao: e.target.value })}
                    />
                  </label>

                  <div className="grid grid-2">
                    <label>
                      <span>Telefone de contato</span>
                      <input
                        type="tel"
                        value={formCarteira.contato_telefone}
                        onChange={(e) => setFormCarteira({ ...formCarteira, contato_telefone: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>Email de contato</span>
                      <input
                        type="email"
                        value={formCarteira.contato_email}
                        onChange={(e) => setFormCarteira({ ...formCarteira, contato_email: e.target.value })}
                      />
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
                        <button
                          className="btn btn-secundario"
                          onClick={() => analisarDaCarteira(im.id)}
                          disabled={analisando[`c${im.id}`]}
                        >
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
    </div>
  );
}

export default App;
