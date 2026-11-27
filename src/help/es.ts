import type { HelpTexts } from "../helpContent";

// Redacción neutra: la app nunca se dirige al usuario directamente (ni tú
// ni usted) — instrucciones en infinitivo, explicaciones con «se».
export const HELP_ES: HelpTexts = {
  categories: {
    erste: "Primeros pasos",
    start: "Pantalla de inicio",
    kopfleiste: "Barra superior y caja de herramientas",
    zeitleiste: "Línea de tiempo",
    auswahl: "Selección y edición en lote",
    detail: "Vista de detalle",
    suche: "Búsqueda",
    hinzufuegen: "Añadir archivos",
    datum: "Fechas y datación con IA",
    verwalten: "Gestionar",
    protokoll: "Historial y deshacer",
    tagebuch: "Diario y grabaciones",
    phasen: "Áreas temáticas y fases",
    einstellungen: "Ajustes",
    tastatur: "Teclado y ratón",
    faq: "Preguntas frecuentes",
  },
  topics: {
    // ---------- Primeros pasos ----------
    "intro-was": {
      title: "¿Qué es CronoStream?",
      blocks: [
        {
          p: "CronoStream ordena fotos, vídeos, grabaciones de audio, documentos, correos y entradas de diario en una única línea de tiempo horizontal: lo anterior a la izquierda, lo posterior a la derecha. Un «stream» es un proyecto en su propia carpeta. Se pueden crear tantos como se quiera, por ejemplo uno para la familia y otro solo para documentos.",
        },
        {
          list: [
            "**Copias, no originales:** al añadir un archivo, CronoStream guarda una copia en la carpeta del stream. Los archivos originales nunca se modifican.",
            "**Todo se puede deshacer:** cada cambio queda en el historial y se puede revertir. Los archivos quitados van primero a la papelera.",
            "**Todo es local:** sin cuenta, sin nube, sin subidas. Incluso la datación con IA pasa solo por el portapapeles. La única conexión a internet es la comprobación de actualizaciones, que se puede desactivar (véase «Acerca de CronoStream»); los archivos y contenidos nunca salen del equipo.",
          ],
        },
      ],
    },
    "intro-erster": {
      title: "Un primer stream en cinco pasos",
      blocks: [
        {
          steps: [
            "En la pantalla de inicio, hacer clic en **Crear un stream**, escribir un nombre y pulsar **Elegir ubicación**. CronoStream crea allí una carpeta nueva y la abre.",
            "Añadir archivos: arrastrar una carpeta desde el gestor de archivos a la ventana, o hacer clic en el **+** dorado y marcar archivos en el explorador.",
            "En la ventana de revisión, comprobar la fecha detectada de cada archivo y hacer clic en **Añadir**.",
            "En la línea de tiempo, hacer zoom con la rueda del ratón y desplazarse arrastrando con el botón pulsado. Un clic en una ficha abre la vista de detalle.",
            "Corregir fechas erróneas: hacer clic en la fecha en la vista de detalle o cambiar varios archivos a la vez con **Editar**.",
          ],
        },
      ],
    },
    "intro-originale": {
      title: "¿Qué pasa con los archivos originales?",
      blocks: [
        {
          p: "Nada. Al añadir un archivo se copia a la carpeta del stream y el original queda intacto en su sitio. La fecha, el nombre, la nota y el giro solo cambian la entrada en CronoStream, nunca el archivo en el disco.",
        },
        {
          p: "Quitar o eliminar definitivamente algo solo afecta, como mucho, a la copia de trabajo en la carpeta del stream. El original es además la red de seguridad: si falta una copia de trabajo, CronoStream recupera el archivo desde allí al restaurar.",
        },
      ],
    },
    "intro-hilfe": {
      title: "¿Dónde hay ayuda en la app?",
      blocks: [
        {
          list: [
            "**Centro de ayuda (?) arriba a la derecha:** **Inicio rápido** muestra los temas más importantes, **Ver todos los temas** todas las categorías. La búsqueda abarca siempre todos los temas. Los enlaces **Ver también** bajo un tema llevan a temas relacionados.",
            "**Pequeños símbolos ?** junto a los controles muestran una explicación al pasar el ratón. La mayoría de los botones también tienen una descripción emergente.",
            "**Avisos únicos** aparecen la primera vez que se usa una función. **No volver a mostrar** los oculta para siempre.",
          ],
        },
        { p: "Bajo el campo de búsqueda, **▶ Vídeos tutoriales ↗** abre en el navegador la sección de vídeos de la página de ayuda en felixheck.de, en el idioma de la interfaz." },
        { p: "El centro de ayuda se cierra con Esc, la × o un clic fuera de él. La línea de tiempo sigue visible mientras tanto." },
      ],
    },

    // ---------- Pantalla de inicio ----------
    "start-anlegen": {
      title: "Crear un stream nuevo",
      blocks: [
        {
          steps: [
            "Hacer clic en **Crear un stream**.",
            "Escribir un nombre, por ejemplo «Mi vida».",
            "Pulsar **Elegir ubicación** y seleccionar una carpeta. CronoStream crea dentro una subcarpeta con ese nombre, que contiene la base de datos, las miniaturas y las copias de todos los archivos.",
          ],
        },
        { p: "El nuevo stream se abre enseguida y al principio está vacío." },
      ],
    },
    "start-oeffnen": {
      title: "Abrir un stream",
      blocks: [
        {
          list: [
            "**Clic en una ficha:** en **Streams existentes** hay una ficha por cada stream conocido, el último abierto en primer lugar.",
            "**Abrir carpeta de stream** (en la pantalla de inicio, junto a **Crear un stream**): abre una carpeta de stream que aún no está en la lista, por ejemplo de un USB o de una copia de seguridad.",
          ],
        },
        { p: "Mientras se abre, una capa muestra «Abriendo stream», con progreso en colecciones grandes. La flecha ← arriba a la izquierda lleva luego de vuelta a la pantalla de inicio." },
      ],
    },
    "start-warnungen": {
      title: "Mensajes al abrir",
      blocks: [
        {
          list: [
            "**Stream no encontrado:** la carpeta se ha movido o eliminado. **Quitar de la lista** elimina la entrada. Si la carpeta está ahora en otro lugar, se puede abrir de nuevo con **Abrir carpeta de stream**.",
            "**El stream se ha movido:** la carpeta se movió o copió a mano, o está en una unidad con otra ruta (otra letra de unidad, un USB en otro ordenador). **Ajustar rutas** la orienta a la nueva ubicación; antes la aplicación guarda una copia de la base de datos en la carpeta del stream («cronostream.db.vor-pfadanpassung-…»). **Cancelar** la abre como hasta ahora.",
            "**No se cerró correctamente:** CronoStream no se cerró bien la última vez, por ejemplo tras un fallo. **Abrir de todas formas** suele ser seguro.",
            "**Ya está abierto:** el stream está abierto en otra ventana y primero hay que cerrarlo allí. Solo si es seguro que ya no está abierto en ningún sitio (p. ej. tras un fallo), sirve **Cerrar todas las instancias y continuar**.",
          ],
        },
      ],
    },
    "start-kachel": {
      title: "El menú de una ficha de stream",
      blocks: [
        { p: "Un clic en la ficha abre el stream. El número de la ficha indica los archivos que contiene. Una insignia marca el stream predeterminado. El menú **⋯** (Más acciones) ofrece:" },
        {
          list: [
            "**Abrir:** igual que hacer clic en la ficha.",
            "**Renombrar:** solo cambia el nombre mostrado; la carpeta en el disco conserva el suyo.",
            "**Establecer como stream predeterminado** o **Quitar stream predeterminado:** el stream predeterminado se abre automáticamente en el próximo inicio de la aplicación, pero solo al iniciarla, no tras la flecha de volver ni tras un cambio de idioma. Solo puede haber uno. Si no se puede abrir (falta la carpeta, unidad sin montar, abierto en otra ventana), la pantalla de inicio permanece con un aviso.",
            "**Quitar de la lista:** la carpeta no se toca y se puede volver a añadir en cualquier momento con **Abrir carpeta de stream**.",
            "**Eliminar definitivamente…:** elimina todo el stream del disco, con dos confirmaciones.",
          ],
        },
        { p: "El campo de búsqueda sobre las fichas solo aparece a partir de 11 streams. Con muchos streams solo se desplaza la lista de fichas, no toda la página." },
      ],
    },
    "start-duplizieren": {
      title: "Hacer una copia de un stream",
      blocks: [
        { p: "Ya no existe una función propia de duplicar. La copia se hace con las operaciones con archivos:" },
        {
          steps: [
            "Abrir el stream y elegir 🛠 **Gestionar** › **Operaciones con archivos**.",
            "Marcar todos los archivos con Ctrl+A.",
            "Elegir **Añadir a otro stream** (o copiar) y, en el diálogo de destino, **＋ Crear nuevo stream**: escribir un nombre y una ubicación; el nuevo stream sirve enseguida como destino.",
          ],
        },
        { p: "Para una copia completa con marca de tiempo sirve **Crear copia de seguridad** en 🛠 **Gestionar** › **Copia de seguridad**. En ambos casos el original no cambia." },
      ],
    },
    "start-loeschen": {
      title: "Eliminar un stream",
      blocks: [
        {
          steps: [
            "En el menú **⋯** de la ficha, elegir **Eliminar definitivamente…**. CronoStream revisa la carpeta y muestra nombre, número de archivos y tamaño. Si hay archivos ajenos en la carpeta que no pertenecen al stream, se enumeran por su nombre, porque también se eliminarían.",
            "Decidir sobre **Conservar el historial** (activado por defecto): la base de datos se guarda antes de eliminar la carpeta, y el stream se puede restaurar más tarde. Sin la marca, la eliminación es definitiva.",
            "Pulsar **Continuar** y confirmar **Eliminar definitivamente** en el segundo diálogo. El botón queda bloqueado unos segundos para que un doble clic accidental no lo active.",
          ],
        },
        { note: "La carpeta del stream se elimina de verdad del disco para liberar espacio. Los archivos originales fuera de la carpeta no se tocan." },
      ],
    },
    "start-wiederherstellen": {
      title: "Restaurar un stream eliminado o una copia de seguridad",
      blocks: [
        { p: "Ambas opciones están en el enlace discreto **Restaurar y papelera…** al pie de la pantalla de inicio." },
        { p: "**Stream eliminado**" },
        {
          steps: [
            "Abrir el enlace y elegir **Streams eliminados**. Ahí aparece cada stream eliminado con **Conservar el historial**, con la fecha de eliminación y el número de archivos aún disponibles.",
            "Hacer clic en **Restaurar**, escribir un nombre y pulsar **Elegir ubicación y restaurar**.",
          ],
        },
        { p: "CronoStream vuelve a leer los archivos desde sus carpetas de origen. Vuelven los nombres, fechas, notas, giros y todo el historial. Un informe indica las fuentes que han cambiado o faltan desde entonces. Los archivos sin fuente conservan su historial, pero no aparecen en la línea de tiempo." },
        { p: "**Descartar** elimina definitivamente el historial guardado. Después ya no es posible restaurar." },
        { p: "**Copia de seguridad**" },
        {
          steps: [
            "Abrir el enlace y elegir **Restaurar desde copia de seguridad**.",
            "Elegir la carpeta de la copia, escribir un nombre y elegir una ubicación.",
          ],
        },
        { p: "CronoStream crea una copia completa e independiente de la copia de seguridad y luego la abre. La copia de seguridad no cambia." },
      ],
    },

    // ---------- Barra superior y caja de herramientas ----------
    "kopf-symbole": {
      title: "¿Qué significan los símbolos de la barra superior?",
      blocks: [
        {
          keys: [
            ["←", "Volver a la pantalla de inicio"],
            ["+", "Añadir archivos: abre el explorador en **Añadir** (igual que el botón dorado grande abajo a la derecha)"],
            ["📥", "Abre la pequeña ventana **Bandeja** para reunir archivos"],
            ["✨", "**Revisar**: datación con IA"],
            ["🛠", "**Gestionar**: operaciones con archivos, historial, duplicados, papelera, copia de seguridad"],
            ["🔍", "Mostrar u ocultar la búsqueda (Ctrl+F)"],
            ["🎬 / 🎙️", "Grabar vídeo o audio"],
            ["Diario", "Nueva entrada de diario con la hora actual"],
            ["Áreas temáticas", "Gestionar áreas temáticas y fases"],
            ["⚙", "Ajustes"],
            ["?", "Este centro de ayuda"],
            ["☕", "Invítame a un café: abre la página de donaciones en el navegador"],
            ["⤢ / ⤡", "Pantalla completa sí / no"],
          ],
        },
        { p: "Cuando hay archivos esperando en la cola, aparece abajo a la derecha, junto al + grande, un botón redondo **Archivos en la bandeja** con un contador." },
        { p: "Abajo a la izquierda aparece el símbolo del ojo del **modo privado** en cuanto está configurado: ojo = todos los archivos visibles, ojo tachado = archivos privados ocultos. Se puede desactivar en ⚙ › Privacidad." },
      ],
    },
    "kopf-statistik": {
      title: "Línea de estadísticas y nombre",
      blocks: [
        { p: "Junto a la flecha de volver está el nombre del stream abierto; se puede cambiar en la pantalla de inicio (lápiz de la ficha). En el centro, la línea de estadísticas muestra cuántas imágenes, vídeos, audios, documentos y otros archivos contiene el stream y cuánto espacio ocupa." },
      ],
    },
    "kopf-vollbild": {
      title: "Pantalla completa",
      blocks: [
        { p: "⤢ en el extremo derecho activa la pantalla completa, ⤡ la desactiva. Esc sale siempre de la pantalla completa, en cualquier pantalla." },
        { note: "Esc cierra además la capa abierta superior (p. ej. la vista de detalle o la búsqueda). En pantalla completa, un solo Esc suele hacer ambas cosas a la vez." },
      ],
    },
    "kopf-werkzeugkasten": {
      title: "La caja de herramientas (explorador de archivos)",
      blocks: [
        { p: "+, ✨, 🛠 y ⚙ abren la misma capa a pantalla completa sobre la línea de tiempo, cada uno en un área distinta. A la izquierda se elige el área, arriba la pestaña. La barra izquierda se puede desplegar y plegar." },
        {
          list: [
            "**Añadir:** Vista general, Imagen individual, Buscar en el disco, Importar lista",
            "**Revisar:** Corregir fecha con IA",
            "**Gestionar:** Operaciones con archivos, Historial, Duplicados, Papelera, Copia de seguridad",
            "**Ajustes:** todos los ajustes y «Acerca de CronoStream»",
          ],
        },
        { p: "**✓ Listo** arriba a la derecha cierra la caja de herramientas. La línea de tiempo conserva su zoom y su posición." },
      ],
    },
    "kopf-peek": {
      title: "Vista previa en miniatura de la línea de tiempo",
      blocks: [
        { p: "En Operaciones con archivos, abajo a la izquierda flota una pequeña vista previa de la línea de tiempo. En qué otras vistas aparece se elige en ⚙ › **Línea de tiempo y pistas** › **Vista previa en miniatura de la línea de tiempo**, con un interruptor por vista. Un clic en ella oculta la caja de herramientas y deja ver la línea de tiempo real. La píldora **Volver a…** regresa a la última pestaña activa tal como estaba." },
        { p: "La vista previa y la píldora se pueden mover con el ratón. La vista previa también se puede reducir u ocultar." },
      ],
    },

    // ---------- Línea temporal ----------
    "zl-bewegen": {
      title: "Hacer zoom y desplazarse",
      blocks: [
        {
          list: [
            "**Zoom:** rueda del ratón, sin tecla adicional. La fecha bajo el puntero se queda en su sitio.",
            "**Desplazarse:** arrastrar con el botón izquierdo pulsado. A propósito no hay barra de desplazamiento.",
            "**Rango:** desde la vista general (todo el stream cabe en la ventana; así empieza) hasta una sola hora.",
          ],
        },
        { p: "A una fecha concreta se llega con el periodo de la búsqueda o con un clic en una barra de fase. El zoom y la posición se mantienen mientras se trabaja en la caja de herramientas." },
      ],
    },
    "zl-beschriftung": {
      title: "La rotulación sobre las pistas",
      blocks: [
        { p: "La fila superior cambia con el zoom: años en la vista general, luego meses, semanas, días y por último horas. A nivel de día, la medianoche se marca con la fecha y una línea más gruesa. El periodo actual queda fijado en el borde izquierdo (p. ej. «mayo 2012»). Las columnas de día estrechas (menos de 110 px) solo llevan el número del día." },
        { p: "En la vista general, un clic en un año abre todos los archivos de ese año como clúster. Los meses, semanas y días de la fila superior abren igualmente un clúster con todos los archivos del periodo (no los rótulos de la vista de día con cuadrícula de horas). Los periodos sin archivos no se pueden pulsar, los pulsables se subrayan al pasar el ratón; arrastrar un rótulo solo desplaza la línea de tiempo." },
      ],
    },
    "zl-spuren": {
      title: "Pistas: documentos, imágenes, vídeos, audios",
      blocks: [
        { p: "Cada tipo de archivo tiene su propia pista horizontal. Correos, entradas de diario y otros archivos van en la pista de documentos. Una pista solo aparece si el stream contiene archivos de ese tipo: con el primer vídeo aparece la pista de vídeo." },
        { p: "Las pistas existentes se reparten la altura. Cuantas menos pistas haya, más grandes son las fichas. El orden se define en los ajustes (**Orden de pistas y visibilidad**)." },
      ],
    },
    "zl-kacheln": {
      title: "Qué muestran las fichas",
      blocks: [
        {
          list: [
            "**Imágenes y vídeos:** miniatura; al pasar el ratón, la fecha.",
            "**Documentos y PDF:** primero un símbolo; al pasar el ratón, la vista previa de la página.",
            "**Audio:** imagen de audio con el nombre del archivo.",
            "**Correos:** símbolo de sobre con remitente y fecha; al pasar el ratón, remitente y destinatario.",
            "**Entradas de diario:** imagen de diario con la primera línea del texto, la fecha y, si las hay, un clip con el número de adjuntos. El lápiz de la ficha abre la entrada directamente para editarla.",
          ],
        },
        { p: "Las fichas son más grandes en el centro de la ventana y se reducen hacia los bordes (efecto lupa). La ficha bajo el puntero se amplía. Un clic abre la vista de detalle; para una pila, ver «Pilas»." },
      ],
    },
    "zl-stapel": {
      title: "Pilas: muchos archivos en poco espacio",
      blocks: [
        { p: "Cuando los archivos de una pista están tan juntos que sus fichas se solaparían, CronoStream los agrupa en una pila: hasta tres fichas desplazadas con un círculo dorado que indica la cantidad. Al acercar, las pilas se dividen; al alejar, se vuelven a unir. Las fichas conservan su tamaño: permanecen en las columnas más gruesas hasta que una columna de la cuadrícula más fina (meses, días, horas) es tan ancha como una ficha; solo entonces se separan las pilas en las líneas finas. La nueva cuadrícula aparece tenue al principio y se intensifica al acercar." },
        {
          list: [
            "**Señalar (solo con el activador Hover):** si el puntero se detiene un momento sobre una pila, esta se despliega: arriba la vista previa grande, debajo todos los archivos de la pila en cuadrícula. Al pasar por una ficha pequeña cambia la vista previa.",
            "**Clic (por defecto):** despliega la pila: arriba la vista previa grande, debajo todos los archivos en cuadrícula. Si en los ajustes está elegido «Acercar en la línea de tiempo», el clic acerca en su lugar hasta que la pila se deshace en fichas individuales; si no es posible porque los archivos están demasiado juntos, la pila se despliega.",
            "**En la pila desplegada:** un clic en una ficha abre la vista de detalle, Ctrl+clic la marca. Esc o un clic en el fondo vacío cierra la pila.",
          ],
        },
        { p: "El activador, la acción y el freno de zoom se configuran en los ajustes, en **Pilas y zoom**." },
      ],
    },
    "zl-cluster": {
      title: "Clústeres temporales",
      blocks: [
        { p: "Un clúster es una vista de un conjunto de archivos: fondo oscurecido, título con la cantidad, vista previa grande y debajo la cuadrícula de fichas. Las casillas documentos, imágenes, vídeos, audios filtran por tipo. Se usa igual que una pila desplegada. Esc, la ✕ o un clic en el fondo vacío lo cierra." },
        {
          list: [
            "**Periodo:** clic en un año, mes, semana o día en la rotulación sobre las pistas",
            "**Resultados de búsqueda:** **Ver resultados** en la búsqueda",
            "**Misma nota:** **Todos con esta nota** en la vista de detalle",
            "**Adjuntos del diario:** **Mostrar archivos** en una entrada de diario",
          ],
        },
        { p: "Si la vista de detalle se abre desde un clúster, las flechas solo recorren los archivos de ese clúster. Tras Esc vuelve a aparecer el clúster." },
      ],
    },
    "zl-rechtsklick": {
      title: "Clic derecho en una ficha",
      blocks: [
        {
          list: [
            "**N Editar** (solo con una selección activa): pasa los archivos marcados a las operaciones con archivos",
            "**Abrir en la app predeterminada**",
            "**Mostrar archivo en la carpeta del stream** / **Mostrar archivo en la carpeta de origen** (en gris si el original ya no existe)",
            "En imágenes: **girar 90° a la izquierda/derecha**, **girar 180°**. Solo gira la visualización, el archivo no cambia.",
            "**Añadir a otro stream**: pone el archivo en la cola de otro stream",
            "**Quitar**: quita el archivo del stream (a la papelera)",
          ],
        },
        { p: "En las entradas de diario, el menú solo ofrece **Editar** y **Quitar**." },
      ],
    },
    "zl-rechtsklick-frei": {
      title: "Clic derecho en un hueco libre",
      blocks: [
        {
          list: [
            "**Añadir entrada de diario aquí:** nueva entrada con la fecha del punto del clic, también en el pasado",
            "**Pegar del portapapeles** (solo si hay una imagen en el portapapeles): pregunta si añadir la imagen como archivo de imagen normal o como entrada de diario, con la fecha del punto del clic",
          ],
        },
      ],
    },
    "zl-datum-ziehen": {
      title: "Cambiar la fecha arrastrando una ficha",
      blocks: [
        { p: "Con **Cambiar fecha arrastrando fichas** activado en los ajustes, una ficha se puede arrastrar en horizontal hasta su lugar correcto. Al soltarla, CronoStream calcula la fecha a partir de la posición. La precisión depende del zoom: para una hora exacta conviene acercar mucho." },
        { p: "Viene desactivado para que nada se mueva por accidente; entonces arrastrar sobre una ficha desplaza toda la línea de tiempo. Cada cambio queda en el historial." },
      ],
    },
    "zl-ohne-datum": {
      title: "Aviso «archivos con fecha ilegible»",
      blocks: [
        { p: "Los archivos cuya fecha no se puede leer no aparecen en la línea de tiempo. En su lugar, arriba a la izquierda se muestra un aviso con su número. Se encuentran en las operaciones con archivos (Gestionar), donde se les puede asignar una fecha." },
        { p: "Al abrir un stream grande, «Cargando stream…» muestra el progreso. Después, las miniaturas aparecen poco a poco a medida que su parte de la línea de tiempo se hace visible." },
      ],
    },
    "zl-leer": {
      title: "¿Qué se ve mientras un stream está vacío?",
      blocks: [
        { p: "Una imagen con el texto «Aquí aún no hay nada.» Para empezar: arrastrar archivos a la ventana, hacer clic en el **+** dorado del texto o grabar contenido directamente con 🎬 / 🎙️." },
      ],
    },

    // ---------- Selección ----------
    "auswahl-markieren": {
      title: "Marcar varios archivos en la línea de tiempo",
      blocks: [
        {
          list: [
            "**Ctrl+clic** (Mac: Cmd+clic) en una ficha la marca sin abrirla. Las fichas marcadas llevan un anillo dorado. En la línea de tiempo, Ctrl+clic en una pila marca toda la pila; en una pila desplegada o un clúster se marcan fichas sueltas.",
            "**Ctrl+A** marca todas las fichas visibles de la línea de tiempo. En un clúster o una pila desplegada marca su contenido (según el filtro de tipo); un segundo Ctrl+A lo desmarca.",
            "**Esc** o la ✕ de la barra de selección anula la selección.",
          ],
        },
        { p: "Abajo en el centro aparece entonces una barra «N seleccionados» con el botón **Editar**." },
      ],
    },
    "auswahl-bearbeiten": {
      title: "«Editar»: pasar la selección a las operaciones con archivos",
      blocks: [
        { p: "**Editar** en la barra de selección (o **N Editar** en el menú del clic derecho) abre las operaciones con archivos en Gestionar, limitadas exactamente a esos archivos, todos ya marcados. Allí están todas las acciones en lote: cambiar fecha, enviar a la IA, añadir nota, copiar o mover a otro stream, exportación para impresión, lista de rutas, quitar." },
      ],
    },
    "auswahl-beispiel": {
      title: "Ejemplo: una nota común para un evento",
      blocks: [
        {
          steps: [
            "Acercar el zoom a los archivos que van juntos, p. ej. un cumpleaños repartido en varias pilas.",
            "Marcarlos todos con Ctrl+clic.",
            "Hacer clic en **Editar**. Se abren las operaciones con archivos con exactamente esos archivos.",
            "Elegir **Acciones** › **Añadir nota…**, escribir p. ej. «80 cumpleaños de la abuela» y hacer clic en **Añadir**.",
          ],
        },
        { p: "A partir de ahora la búsqueda encuentra todos esos archivos. Con uno de ellos abierto en la vista de detalle, **Todos con esta nota (N)** los muestra juntos como clúster, por muy dispersos que estén en la línea de tiempo." },
      ],
    },

    // ---------- Vista detallada ----------
    "detail-oeffnen": {
      title: "Abrir, recorrer y cerrar la vista de detalle",
      blocks: [
        { p: "Un clic en una ficha individual, en una ficha de una pila o un clúster, o un doble clic en un resultado de búsqueda abre la vista de detalle." },
        {
          list: [
            "**Recorrer:** flechas ←/→ o los botones redondos de flecha, en orden cronológico por toda la línea de tiempo. Qué tipos de archivo se recorren lo define **Navegación en la vista de detalle**. Desde un clúster, el recorrido se queda dentro de sus archivos.",
            "**Símbolo de filtro arriba a la izquierda:** abre una ventana emergente donde se pueden cambiar en vivo los tipos de archivo (imágenes, vídeos, audio, documentos, Todos) que se recorren. El tipo del archivo actual permanece activado. La elección solo vale hasta cerrar la vista de detalle; el ajuste **Navegación en la vista de detalle** sigue siendo el valor inicial. En un clúster de búsqueda el símbolo no aparece.",
            "**Cerrar:** Esc, la ✕ arriba a la derecha o un clic junto a la tarjeta. La línea de tiempo salta entonces al último archivo visto y su ficha destella un momento; queda encima de su pila. Si el punto de partida queda fuera de vista, aparece a la izquierda de la ficha un chip «↩ Volver a <mes año>» (o Esc) que lleva a la vista anterior, con la cuadrícula del clúster incluida. Si se recorrió dentro de una cuadrícula de clúster, al cerrar se vuelve a la cuadrícula como antes.",
            "**Clic derecho en el contenido:** el mismo menú que en la línea de tiempo.",
          ],
        },
        { p: "Debajo del contenido están el nombre, la fecha, el botón de quitar, el campo de nota y una línea con el tamaño y las fechas de creación y modificación." },
      ],
    },
    "detail-bild": {
      title: "Ampliar y mover imágenes",
      blocks: [
        { p: "Rueda del ratón hacia arriba (o +) hace que la imagen «salga» de la tarjeta: ocupa toda la altura de la ventana y lo demás desaparece. Al seguir girando la rueda o pulsando + otra vez amplía hasta seis veces; arrastrando se mueve la imagen." },
        { p: "Para volver: rueda hacia abajo, −, Esc o un clic junto a la imagen." },
      ],
    },
    "detail-player": {
      title: "Reproducir vídeo y audio",
      blocks: [
        { p: "Los vídeos y audios se reproducen solos en el reproductor integrado. Tiene reproducir/pausa, barra de posición, ±10 segundos, volumen y silencio, velocidad de 0,5× a 2× y, en vídeos, un botón de pantalla completa." },
        { p: "Si el reproductor no puede reproducir un formato (WMA antiguo, WMV, AVI DivX, Cinepak/Indeo, WAV GSM o ADPCM, AMR y otros), indica «Convirtiendo el formato para la reproducción…». El archivo se convierte una sola vez con ffmpeg a WebM (VP9/Opus) y se reproduce la copia. Las copias están en la carpeta de caché del equipo (2 GB como máximo); el original del stream no cambia." },
      ],
    },
    "detail-dokumente": {
      title: "Documentos, PDF y correos",
      blocks: [
        {
          list: [
            "**PDF y documentos:** vista previa o el texto extraído, además de **Abrir en la app predeterminada**. Si no se pudo leer texto, se indica.",
            "**Correos (.eml, .msg de Outlook):** cabecera con asunto, de, para, cc y fecha, y debajo el texto. A la derecha, **Adjuntos** enumera todos los adjuntos con su tamaño; un clic abre uno en su programa predeterminado. Las imágenes incrustadas en el correo (en el HTML o como adjunto al que remite el texto) se muestran, con un máximo de 25 MB por correo. Las imágenes de internet siguen bloqueadas. Los enlaces del texto (direcciones web, direcciones de correo, números de teléfono) se abren con un clic en el programa predeterminado; las páginas web, en el navegador.",
            "**Otros archivos:** nombre y **Abrir en la app predeterminada**. Si el archivo es un programa o script (.exe, .bat, .sh, .desktop, .lnk …), antes un diálogo pregunta si de verdad debe abrirse. Esto vale en todos los lugares donde se abren archivos externamente (línea de tiempo, adjuntos de correo y de diario, explorador de archivos).",
            "**Las entradas de diario** abren su propio diálogo.",
          ],
        },
      ],
    },
    "detail-zeitstempel": {
      title: "Cambiar la fecha y la hora de un archivo",
      blocks: [
        { p: "Hacer clic en la píldora con fecha y hora de la vista de detalle. Se convierte en el campo de fecha; Intro aplica, Esc cancela. Al lado, una etiqueta indica el origen de la fecha: Metadatos, Nombre de archivo, Creado, Modificado, Fecha propia, De la IA o Grabado." },
        { p: "Solo cambia la fecha en CronoStream; el archivo en el disco no se toca. El cambio queda en el historial." },
        { p: "Si la fecha y la hora se muestran además discretamente sobre la imagen lo controla **Mostrar fecha como superposición**." },
      ],
    },
    "detail-name-notiz": {
      title: "Nombre y nota",
      blocks: [
        { p: "**Nombre:** hacer clic en el campo de nombre, cambiarlo y guardarlo con Intro o **Confirmar** (Esc cancela). Solo cambia el nombre mostrado en CronoStream, no el nombre del archivo en el disco." },
        { p: "**Nota:** escribir en «Nota sobre este archivo…». La nota se guarda sola: poco después de la última pulsación, al pasar al siguiente archivo y al cerrar. La búsqueda encuentra las notas." },
        { p: "**Todos con esta nota (N):** si al menos dos archivos tienen exactamente el mismo texto de nota, aparece este botón. Abre todos ellos como clúster." },
      ],
    },
    "detail-entfernen": {
      title: "Descartar archivos en la vista de detalle",
      blocks: [
        { p: "El botón rojo **Quitar** o la tecla Supr quita el archivo del stream y muestra enseguida el siguiente; así se revisa una colección en minutos. Los archivos quitados están en la papelera y se pueden recuperar desde allí o desde el historial." },
        { note: "Si **Eliminar la copia de trabajo al quitar** está activado, CronoStream pregunta antes: la copia de trabajo y la entrada se eliminan entonces definitivamente al instante." },
      ],
    },
    "detail-herausziehen": {
      title: "Arrastrar archivos a otros programas",
      blocks: [
        { p: "Arrastrar el contenido de la vista de detalle con el botón pulsado a otro programa, como un correo o un gestor de archivos. Allí se crea una copia. En una imagen ampliada, arrastrar mueve la imagen; para sacarla, mantener pulsado además Alt." },
      ],
    },

    // ---------- Búsqueda ----------
    "suche-bedienen": {
      title: "Buscar",
      blocks: [
        { p: "🔍 en la barra superior o Ctrl+F abre la barra de búsqueda sobre la línea de tiempo. La búsqueda empieza poco después de la última pulsación y no distingue mayúsculas de minúsculas." },
        {
          list: [
            "**Se busca en:** nombre mostrado y original, el texto de PDF, documentos, correos y entradas de diario, todas las notas y los nombres de los adjuntos del diario.",
            "**Periodo:** el interruptor **Periodo** muestra los campos desde/hasta. Texto y periodo se pueden combinar o usar por separado.",
            "**Búsquedas recientes:** un clic en el campo vacío, en ▾ o la tecla ↓ despliega la lista de las últimas 50 búsquedas de este stream (8 visibles, con desplazamiento por rueda o flechas). Clic o Intro recupera texto y filtros, × quita una entrada, **Borrar historial** todas. Ctrl+F por sí solo no abre la lista.",
            "**Cerrar:** la ✕ de la barra de búsqueda, 🔍 o Esc.",
          ],
        },
      ],
    },
    "suche-ergebnisse": {
      title: "Ver y recorrer los resultados",
      blocks: [
        { p: "Las fichas encontradas llevan un anillo dorado, la actual uno brillante; todo lo demás se oscurece. El contador muestra p. ej. «3/12»." },
        {
          list: [
            "**Intro / Mayús+Intro** o los botones de flecha saltan al resultado siguiente o anterior. La línea de tiempo se desplaza hasta él y acerca lo suficiente para que no quede oculto en una pila.",
            "**Lista de resultados** bajo la barra: un clic muestra el resultado en la línea de tiempo, un doble clic lo abre. Con un clúster abierto, la lista se oculta.",
            "**Ver resultados** abre todos los resultados como clúster. Si cambia la búsqueda, el clúster la sigue; en la vista de detalle las flechas se quedan entonces en los resultados.",
          ],
        },
      ],
    },

    // ---------- Añadir archivos ----------
    "add-wege": {
      title: "Todas las formas de añadir archivos",
      blocks: [
        {
          list: [
            "**Arrastrar a la ventana:** arrastrar archivos o carpetas desde el gestor de archivos a la ventana principal.",
            "**Ventana Bandeja (📥):** una pequeña ventana para reunir archivos que siempre queda en primer plano.",
            "**Explorador (+):** recorrer y marcar carpetas (Vista general, Imagen individual), buscar en el disco o importar una lista de rutas.",
            "**Portapapeles:** Ctrl+V en la línea de tiempo o clic derecho › **Pegar del portapapeles**.",
            "**Crear contenido nuevo:** entradas de diario y grabaciones de vídeo/audio.",
            "**Desde otro stream:** **Añadir a otro stream**, o copiar/mover en las operaciones con archivos.",
          ],
        },
        { p: "Siempre se crea una copia en la carpeta del stream; el original no se toca." },
      ],
    },
    "add-drop": {
      title: "Arrastrar archivos a la ventana principal",
      blocks: [
        { p: "En cuanto se arrastran archivos sobre la ventana aparece una capa con «Soltar para añadir los archivos». Las carpetas se expanden en sus archivos y los archivos ocultos se omiten. Después se abre la ventana de revisión **Archivos en la bandeja**. Los **correos** también se pueden arrastrar directamente desde el programa de correo, igualmente a la bandeja y a una entrada de diario: en Windows, correos y adjuntos desde Outlook (clásico); varios correos arrastrados juntos desde Evolution se separan en correos individuales. Estos archivos se guardan temporalmente en los datos locales de la app (carpeta «dropped_files») y se borran tras añadirlos o quitarlos de la bandeja. Si no se puede tomar nada de lo arrastrado, aparece un mensaje." },
      ],
    },
    "add-pruefen": {
      title: "La ventana de revisión «Archivos en la bandeja»",
      blocks: [
        { p: "Aquí llegan todos los archivos de la cola, tanto si se arrastraron a la ventana principal, como si se reunieron en la bandeja o se enviaron desde otro stream. Cada ficha muestra una miniatura." },
        {
          list: [
            "**Selección de fecha bajo cada ficha:** todos los candidatos de fecha encontrados, p. ej. «(Metadatos)», «(Nombre de archivo)», «(Creado)», «(Modificado)». La mejor fuente viene preseleccionada.",
            "Las **fichas de correo** muestran asunto, remitente y fecha del correo.",
            "**Cruz en la ficha:** quita el archivo de la cola. En el disco no pasa nada.",
            "**Vaciar lista:** quita todos los archivos de la cola de una vez. Tampoco aquí se tocan los archivos del disco.",
            "**Posible duplicado:** una tarjeta comparativa con «Ya en el stream» y «Recién soltado» una junto a otra. Se descartan uno a uno o con **Descartar todos los duplicados**.",
            "**Archivo no encontrado:** el archivo se ha movido o eliminado entretanto y no se puede añadir.",
          ],
        },
        { p: "Abajo se pueden marcar **Revisar / corregir fechas a mano** y/o **Revisar fechas con IA después de importar**; **Añadir (N)** incorpora los archivos. Al cerrar, CronoStream indica cuántos archivos se han añadido." },
      ],
    },
    "add-ablage": {
      title: "La ventana Bandeja (📥)",
      blocks: [
        { p: "📥 abre una pequeña ventana que siempre queda en primer plano. Mientras se explora el gestor de archivos, se pueden arrastrar allí los hallazgos sin preocuparse por fechas ni revisiones. Aparecen con símbolo y nombre, y un contador muestra «N en espera». Si un archivo ha desaparecido entretanto, su fila aparece tachada. La × de una fila la quita de la bandeja, y **Vaciar lista** (abajo) quita todas las entradas de una vez. Los archivos del disco no se tocan." },
        { p: "El **−** junto a la cruz de cierre reduce la bandeja a un pequeño círculo con el icono de CronoStream y el número de archivos en espera. También se pueden soltar archivos sobre el círculo. Un doble clic restaura la vista normal." },
        { p: "La ventana no tiene barra del sistema. Se mueve con la barra superior con logo y título; el círculo se puede arrastrar desde cualquier punto." },
        { p: "La bandeja también funciona sin la ventana principal. En el AppImage de Linux y en la versión instalada de Windows puede haber una entrada del menú de inicio solo para la bandeja, y esta puede abrirse al iniciar el sistema (⚙ › **Sistema e idioma** › **Inicio**, véase «Inicio: bienvenida, menú de inicio y inicio automático»). Con el parámetro --ablage, el programa se inicia solo con la bandeja. Un segundo inicio acaba en el programa que ya está en marcha en lugar de abrir otro: con --ablage muestra el círculo, si no, la ventana principal." },
        { p: "Sin ventana principal, la bandeja queda como icono en la bandeja del sistema y apenas usa memoria. Un clic izquierdo en el icono abre el círculo; el menú ofrece **Abrir bandeja** y **Salir**. Un clic derecho en el círculo o su ✕ lo devuelve a la bandeja del sistema, aunque la bandeja se haya abierto desde la ventana principal (el icono se crea entonces con el primer clic derecho), y **Salir** en su menú cierra el programa. Sin bandeja del sistema (por ejemplo, por falta de una biblioteca) el círculo permanece visible y su ✕ cierra entonces el programa. En GNOME el icono solo aparece con la extensión «AppIndicator». Si se cierra la ventana principal con la bandeja abierta, esta sigue funcionando y el icono permanece; entonces solo se cierra con **Salir** en el menú del clic derecho del icono." },
        { p: "En Wayland la app arranca a través de XWayland, porque Wayland no deja a una ventana elegir su posición ni mantenerse siempre delante, y la bandeja necesita ambas cosas. La ventana principal puede verse algo más borrosa con escala fraccionaria." },
        { p: "La lista se conserva al cerrar la app. En la ventana principal, el botón redondo **Archivos en la bandeja** abajo a la derecha muestra lo que espera; un clic abre la ventana de revisión." },
      ],
    },
    "add-uebersicht": {
      title: "La pestaña «Vista general» del explorador",
      blocks: [
        { p: "A la izquierda se elige una carpeta: con el campo de ruta (**Ir**), los accesos rápidos (carpeta personal, escritorio, imágenes, documentos, descargas) o las unidades. Sus archivos aparecen como fichas a la derecha." },
        {
          list: [
            "**Clic:** muestra el archivo en la vista previa de la derecha. Allí las imágenes se pueden ampliar y girar, y el vídeo y el audio reproducir. El borde de la vista previa se puede arrastrar.",
            "**Correo en la vista previa:** asunto, remitente y fecha del correo; la fecha de ordenación solo si es distinta. Vale también para la búsqueda en el disco y las operaciones con archivos.",
            "**Desplazarse hacia dentro de la imagen de la vista previa** (rueda hacia delante) abre el zoom libre, igual que la lupa. Solo reacciona la superficie de la imagen; fuera de ella y con la rueda hacia atrás la vista previa se desplaza como antes. También vale al buscar en el disco.",
            "**Doble clic o barra espaciadora:** marca el archivo para añadirlo (marco dorado con marca de verificación).",
            "**Carpetas:** un clic ofrece marcar toda la carpeta (opcionalmente con subcarpetas), un doble clic la abre.",
            "**Flechas** para moverse por la cuadrícula, **Ctrl+A** marca todos los archivos que se pueden añadir.",
            "**↑ Carpeta superior**, **Mostrar archivos de subcarpetas**, chips de tipo (fotos, vídeos, audio, documentos), **Ocultar archivos que ya están en el stream** y **Ordenar** (nombre, tamaño, creado, modificado, con flecha de dirección).",
            "**Clic derecho:** abrir en el programa predeterminado, mostrar carpeta, añadir a otro stream.",
          ],
        },
        { p: "Los archivos que ya están llevan la banda «Ya en el stream». Bajo cada ficha aparece la fecha que se usaría al añadirla, con su origen entre paréntesis. Los archivos marcados que ya están se pueden quitar de nuevo del stream con **Quitar (N)**. Si **Eliminar la copia de trabajo al quitar** está activado, antes un diálogo pregunta, porque entonces se eliminan definitivamente." },
      ],
    },
    "add-sammlung": {
      title: "La colección y «Añadir a CronoStream»",
      blocks: [
        { p: "Todo lo marcado, en todas las carpetas y pestañas visitadas, va a una colección común. Se conserva al cambiar de carpeta e incluso al cerrar la app." },
        { p: "En cuanto hay algo reunido, aparece abajo a la derecha el botón dorado **Añadir a CronoStream** con un contador. Abre la lista de todos los archivos reunidos. Los archivos sueltos se quitan con **Quitar de la lista**. Con las mismas dos casillas de revisión que en la ventana de revisión, **Añadir** los incorpora." },
      ],
    },
    "add-einzelbild": {
      title: "La pestaña «Imagen individual»",
      blocks: [
        { p: "Para recorrer carpetas de fotos como un álbum: una imagen grande cada vez, con las vecinas precargadas. La carpeta es la elegida a la izquierda." },
        {
          keys: [
            ["→", "Imagen siguiente"],
            ["← / Retroceso", "Imagen anterior"],
            ["Espacio", "Marcar o desmarcar"],
          ],
        },
        { p: "Abajo aparecen el nombre, la posición («3 / 120»), los botones de giro y **Marcar**. **Insertar** abre **Revisar antes de añadir**, donde se elige para cada archivo la fuente de la fecha o una fecha propia; **Añadir archivos a CronoStream** los incorpora." },
      ],
    },
    "add-festplatte": {
      title: "La pestaña «Buscar en el disco»",
      blocks: [
        { p: "Busca archivos a partir de la carpeta elegida a la izquierda. La búsqueda se ejecuta en segundo plano y la app sigue siendo utilizable." },
        {
          list: [
            "**Término de búsqueda:** parte del nombre del archivo (vacío = todos los archivos de los tipos elegidos).",
            "**Incluir subcarpetas**, **Tipos de archivo** (imágenes, vídeos, audio, documentos, correos, otros; sin selección = todos).",
            "**Limitar periodo** por **Fecha de captura** o **Copiado al ordenador**.",
            "**Tamaño de archivo** mínimo/máximo.",
            "**Ocultar duplicados:** de varias copias del mismo archivo encontradas, muestra solo una.",
            "**Ocultar archivos que ya están en el stream:** reconoce también copias renombradas.",
            "**Comprobación de contenido:** «Rápida» compara el tamaño y un fragmento corto, «Exhaustiva» el archivo completo byte a byte (más segura, pero más lenta).",
            "**Búsquedas recientes:** el campo de búsqueda recuerda las últimas 50 búsquedas en el disco con sus filtros, comunes a todos los streams. Al elegir una, cambia a esa carpeta y busca al instante.",
            "**Cargar desde el índice:** usa la última búsqueda de esta carpeta sin volver a leer el disco. Periodo, tipo y tamaño se pueden cambiar libremente.",
          ],
        },
        { p: "Una banda de progreso muestra la fase y el tiempo restante; **Cancelar** detiene la búsqueda. Los resultados aparecen en la misma cuadrícula que en la vista general y, al marcarlos, pasan a la colección. Las carpetas con más de unos 200.000 archivos se rechazan; en ese caso, elegir una carpeta más concreta." },
      ],
    },
    "add-liste": {
      title: "La pestaña «Importar lista»",
      blocks: [
        { p: "**Abrir archivo** elige un archivo de texto (.txt) con una ruta completa, incluido el nombre del archivo, en cada línea, p. ej. /home/user/222.jpg. Los archivos válidos se marcan y pasan a la colección; los no encontrados se cuentan. Se añaden como siempre con **Añadir a CronoStream**." },
      ],
    },
    "add-zwischenablage": {
      title: "Pegar una imagen del portapapeles",
      blocks: [
        {
          list: [
            "**Ctrl+V en la línea de tiempo:** abre al instante una nueva entrada de diario con la imagen adjunta y la fecha «ahora». Sin imagen en el portapapeles no pasa nada.",
            "**Clic derecho en un hueco libre › Pegar portapapeles:** pregunta qué hacer con la imagen. **Añadir imagen** crea un archivo de imagen normal con la fecha del punto del clic y lo abre en la vista de detalle. **Añadir entrada de diario** abre el editor del diario con la imagen adjunta.",
          ],
        },
        { p: "La imagen se guarda como JPEG (como PNG si tiene transparencia) y se llama «Portapapeles» (en el idioma de la interfaz) con una marca de tiempo." },
      ],
    },
    "add-anderer-ls": {
      title: "Enviar archivos a otro stream",
      blocks: [
        { p: "**Añadir a otro stream** (clic derecho en una ficha de la línea de tiempo o del explorador) pone el archivo en la cola del stream elegido. Aparece en su ventana de revisión la próxima vez que se abra." },
        { p: "Para transferir archivos al momento sirven **Copiar a otro stream…** y **Mover a otro stream…** en las operaciones con archivos." },
      ],
    },

    // ---------- Fechas e IA ----------
    "datum-quellen": {
      title: "De dónde toma CronoStream la fecha",
      blocks: [
        { p: "En este orden; gana la primera fuente que da una fecha:" },
        {
          steps: [
            "Nombre de archivo de WhatsApp (p. ej. «IMG-20190612-WA0001»)",
            "Metadatos incrustados: hora de captura (EXIF) en fotos, fecha de envío en correos",
            "Fecha en el nombre del archivo (p. ej. «20150207_150541»)",
            "Sistema de archivos: la fecha de creación, salvo que sea posterior a la de modificación; entonces el archivo se copió evidentemente más tarde y vale la de modificación.",
          ],
        },
        { p: "Además, pero nunca de forma automática: **Fecha dentro del archivo**. Los vídeos y las grabaciones de sonido suelen llevar su fecha de grabación (los vídeos de iPhone incluso con zona horaria), los PDF y los archivos de Word, Excel, PowerPoint o LibreOffice su fecha de creación. En la ventana de revisión aparece como otra opción en cuanto se ha leído en segundo plano; en la selección de fecha bajo una ficha, en cuanto el puntero se sitúa sobre ella. Marcar y añadir nunca esperan por ella. También entra en el encargo a la IA. En archivos convertidos o guardados de nuevo a menudo es solo el momento de esa edición; por eso la aplicación nunca la elige por sí sola." },
        { p: "El origen se ve en la ventana de revisión, bajo las fichas del explorador y como etiqueta en la vista de detalle. Las fechas propias, las de la IA y las grabaciones llevan «Fecha propia», «De la IA» y «Grabado»." },
      ],
    },
    "datum-eingabe": {
      title: "Usar el campo de fecha",
      blocks: [
        { p: "En toda la app se usa el mismo campo, con casillas separadas para día, mes, año, hora y minuto." },
        {
          keys: [
            ["0–9", "escribir cifras; el campo pasa solo a la casilla siguiente"],
            ["↑ / ↓", "aumentar o disminuir el valor de la casilla"],
            ["← / →", "cambiar de casilla (también . / :)"],
            ["Retroceso", "borrar la última cifra; en una casilla vacía, volver a la anterior"],
            ["Intro", "aplicar"],
            ["Esc", "cancelar (en la vista de detalle)"],
          ],
        },
        { p: "El día se limita a los días válidos del mes. Se rechazan las fechas futuras y las anteriores al **Año más antiguo para fechas** (un ajuste, 1900 por defecto)." },
      ],
    },
    "datum-batch": {
      title: "Cambiar la fecha de varios archivos a la vez",
      blocks: [
        {
          steps: [
            "Marcar los archivos en las operaciones con archivos (o seleccionarlos en la línea de tiempo y hacer clic en **Editar**).",
            "Elegir **Acciones** › **Cambiar fecha…** (también con clic derecho).",
            "Cada archivo recibe una tarjeta con vista previa, «Antes: …» y su propio campo de fecha.",
            "Con varios archivos, introducir arriba una fecha y el **Desfase** (min por archivo, 5 por defecto) y hacer clic en **Aplicar a todos**. El primer archivo recibe la fecha, el segundo 5 minutos más tarde, etc., ideal para series de fotos.",
            "Ajustar tarjetas sueltas si hace falta y hacer clic en **Guardar**. Solo entonces se escribe, todo de una vez.",
          ],
        },
        { p: "Una fecha no válida impide guardar hasta que se corrige. El cambio se puede deshacer en el historial." },
      ],
    },
    "datum-nach-import": {
      title: "Revisar fechas justo después de importar",
      blocks: [
        { p: "La ventana de revisión y la lista **Añadir a CronoStream** tienen dos casillas. CronoStream recuerda la elección." },
        {
          list: [
            "**Revisar / corregir fechas manualmente:** tras la importación se abren las operaciones con archivos con exactamente los archivos recién añadidos.",
            "**Revisar con IA después de importar:** tras la importación se abre la datación con IA, limitada a esos archivos.",
          ],
        },
        { p: "Con ambas marcadas, primero se abren las operaciones con archivos; **Continuar con la revisión por IA** lleva después a la IA." },
      ],
    },
    "datum-ki": {
      title: "Corregir fechas con IA",
      blocks: [
        { p: "Para archivos con fecha incierta, como fotos escaneadas, una IA puede estimar a menudo la fecha real a partir del nombre, la ruta de la carpeta y los metadatos. CronoStream no contiene ninguna IA ni habla con ninguna: todo pasa por el portapapeles. La pestaña está en ✨ **Revisar** › **Corregir fecha con IA**." },
        {
          steps: [
            "**Elegir archivos:** filtros de periodo (por defecto todos los archivos), campo de fecha, nombre de archivo, **Solo fechas inciertas** y **Ocultar archivos ya fechados por IA**. Luego **Siguiente**.",
            "Opcionalmente, escribir **Instrucciones adicionales para la IA**, p. ej. «Todas las imágenes con IMG_ en el nombre son de las vacaciones de Semana Santa de 2012».",
            "**Copiar al portapapeles** (o **Guardar como archivo**) y pegar el texto en cualquier chat de IA.",
            "Copiar la respuesta de la IA y hacer clic en **Leer ahora desde el portapapeles e importar**.",
            "Revisar la lista: fecha anterior, propuesta (editable), confianza y justificación. Desmarcar las filas no deseadas y hacer clic en **Aplicar**.",
          ],
        },
        { p: "Un informe muestra «X con cambios, Y sin cambios», con **Mostrar cambios** si se desea. Todo queda como una sola acción «Fecha tomada de la IA» en el historial y se puede deshacer entera o por archivo." },
      ],
    },
    "datum-ki-details": {
      title: "Datación con IA: qué se comparte y qué hacer si faltan respuestas",
      blocks: [
        { p: "**Se comparten** solo el nombre del archivo, la ruta de la carpeta, la fecha anterior y su origen, las fechas del sistema de archivos y los metadatos incrustados (p. ej. fecha de captura EXIF, zona horaria, marca de tiempo GPS). Nunca se transfieren imágenes, vídeos ni el contenido de documentos. Pegar el texto, y en qué IA, es siempre una decisión propia y deliberada." },
        { p: "**Respuestas que faltan:** si la IA no respondió a todas las entradas, CronoStream ofrece **Copiar las faltantes al portapapeles**. Este breve complemento se pega en el mismo chat y la respuesta se importa de nuevo; las nuevas propuestas se suman a las existentes. Con muchísimos archivos, **Guardar como archivo** suele ser más fiable." },
        { p: "**Revisar:** un clic en la justificación muestra todos los datos en bruto del archivo. **Ocultar sin cambios** oculta las filas cuyo día no cambia. La confianza está marcada por colores: alta (verde), media (amarillo), baja (naranja)." },
      ],
    },

    // ---------- Gestionar ----------
    "verw-dateiops": {
      title: "Operaciones con archivos: encontrar y marcar archivos",
      blocks: [
        { p: "🛠 **Gestionar** › **Operaciones con archivos** muestra los archivos del stream como cuadrícula de fichas. Aquí se hace todo lo que afecta a muchos archivos a la vez." },
        {
          list: [
            "**Años (izquierda):** **Todos los años** o un año concreto con su cantidad. La primera vez se elige el año más reciente.",
            "**Filtros arriba:** campo de texto (busca en el nombre y el contenido), interruptor **Periodo** con **Marca de tiempo en el stream** o **Añadido el** y desde/hasta, chips de tipo.",
            "**Clic:** muestra el archivo en la vista previa de la derecha (anillo blanco cálido).",
            "**Doble clic o barra espaciadora:** lo marca para la acción en lote (anillo rojo). Las flechas mueven por la cuadrícula.",
            "**Casilla general** arriba a la izquierda o **Ctrl+A:** marcar todos los archivos visibles o desmarcarlo todo. Al lado se muestran la cantidad y el tamaño total.",
          ],
        },
        { p: "Qué hacer con los archivos marcados se elige en el menú **Acciones (N)** o con clic derecho." },
      ],
    },
    "verw-aktionen": {
      title: "El menú Acciones",
      blocks: [
        { p: "Solo se activa cuando hay algo marcado. Las mismas entradas están en el menú del clic derecho, que además permite girar imágenes." },
        {
          list: [
            "**Cambiar fecha…:** una a una o escalonadas con desfase",
            "**Enviar a la IA para datar:** abre la datación con IA con exactamente esos archivos",
            "**Añadir nota…:** añade un término a la nota de todos los archivos marcados (tras una coma si ya hay nota, sin duplicados)",
            "**Girar a la izquierda (90°)** / **Girar a la derecha (90°):** gira todas las fotos marcadas; solo se guarda el valor de giro, el archivo no cambia. Desactivado en cuanto un archivo marcado no es una foto",
            "**Copiar a otro stream…** / **Mover a otro stream…**",
            "**Exportación para impresión…:** copiar fotos a una carpeta con fecha y hora como nombre",
            "**Lista de rutas al portapapeles** / **Lista de rutas como archivo de texto…**",
            "**Quitar del stream:** a la papelera",
          ],
        },
        { p: "Al lado está el botón **Reemplazar archivo en el stream…**. Funciona con independencia de lo marcado." },
      ],
    },
    "verw-uebertragen": {
      title: "Copiar o mover a otro stream",
      blocks: [
        { p: "Tras **Copiar a otro stream…** o **Mover a otro stream…** se elige el destino en la lista de streams. Uno que esté abierto en otro sitio en ese momento aparece bloqueado. Con **＋ Crear nuevo stream** en el diálogo de destino se puede crear uno nuevo (nombre y ubicación) que sirve enseguida como destino." },
        {
          list: [
            "**Copiar:** los archivos se añaden también al destino; aquí todo sigue igual.",
            "**Mover:** copia al destino y solo después quita los archivos de aquí (a la papelera). Nada se elimina de inmediato.",
            "**Comprobación de duplicados:** ya presente significa misma ruta de origen o mismo contenido (tamaño, hash rápido, BLAKE3; los hashes que falten en el destino se calculan después). Primero aparece el diálogo «Archivos ya presentes» con **Omitir los existentes** o **Copiar igualmente** / **Mover igualmente**.",
            "Después, un diálogo de resultado enumera todos los archivos omitidos con su motivo. Tras confirmar, quedan marcados en las operaciones con archivos; al mover, allí se pueden quitar.",
            "Las **notas** se copian también, y con ellas la marca del modo privado. Sin embargo, un archivo solo sigue siendo privado en el destino si allí está configurado el mismo texto de marca.",
            "Las **entradas del diario** llegan completas: texto, todos los adjuntos en su orden y nota. Una entrada con el mismo texto y momento en el destino cuenta como ya presente. Si falta un adjunto en la carpeta de origen, la entrada se omite con el mensaje «Falta el adjunto “…” en la carpeta de origen.» y, al mover, no se quita de aquí.",
            "Ambos lados reciben una entrada en el historial.",
          ],
        },
      ],
    },
    "verw-druckexport": {
      title: "Exportación para servicios de fotolibros e impresión",
      blocks: [
        { p: "Muchos servicios de impresión ordenan las fotos por la fecha y hora del nombre de archivo o la imprimen en el dorso. **Exportación para impresión…** copia las fotos marcadas a una carpeta libremente elegida y nombra cada copia con la fecha y hora de la línea de tiempo, p. ej. «09.10.2026 - 14.30 Uhr.jpg»." },
        {
          list: [
            "Dos fotos del mismo minuto reciben «- 2», «- 3» … al final.",
            "Las fotos giradas en CronoStream se guardan ya giradas.",
            "Los vídeos y documentos se omiten; se indica antes.",
            "Exportar de nuevo a la misma carpeta reemplaza los archivos en lugar de duplicarlos.",
          ],
        },
      ],
    },
    "verw-pfadliste": {
      title: "Lista de rutas: para programas externos",
      blocks: [
        { p: "**Lista de rutas al portapapeles** y **Lista de rutas como archivo de texto…** generan un texto con una ruta completa por línea: las rutas de las copias en la carpeta del stream." },
        { p: "Con ella se pueden, por ejemplo, reducir en lote muchos vídeos grandes con un programa de conversión externo. Después, los resultados se incorporan con **Reemplazar archivo en el stream…**, sin perder fechas, notas ni nombres." },
      ],
    },
    "verw-ersetzen": {
      title: "Reemplazar un archivo en el stream",
      blocks: [
        { p: "Cambia archivos del stream por otra versión del mismo archivo, p. ej. vídeos comprimidos posteriormente." },
        {
          steps: [
            "Hacer clic en **Reemplazar archivo en el stream…**, leer la explicación y pulsar **Elegir carpeta…**. También se buscan las subcarpetas.",
            "Revisar la lista de coincidencias. Un archivo coincide si su nombre contiene el nombre del archivo del stream (sin extensión) como palabra completa, quizá con un añadido y otra extensión: «Vacaciones.mov» coincide con «Vacaciones_comprimido.mp4», pero no con «Vacaciones2.mp4». El tipo de archivo debe ser el mismo. Si hay varios candidatos, hay que elegir uno.",
            "Hacer clic en **Reemplazar archivos**. Un informe muestra antes, después y el espacio ahorrado.",
          ],
        },
        { p: "Se conservan la fecha, las notas, el nombre mostrado, el giro y la posición en la línea de tiempo." },
        { note: "Al reemplazar se elimina el archivo antiguo de la carpeta del stream. Deshacerlo (en el historial) solo es posible mientras el original siga en su carpeta de origen; si falta, la lista lo advierte." },
      ],
    },
    "verw-papierkorb": {
      title: "La papelera",
      blocks: [
        { p: "🛠 **Gestionar** › **Papelera** muestra todos los archivos quitados, con los mismos años, filtros y marcas que las operaciones con archivos. El menú **Acciones** ofrece tres niveles:" },
        {
          list: [
            "**Restaurar:** los archivos vuelven a la línea de tiempo. Si falta la copia de trabajo, CronoStream la recupera de la fuente original.",
            "**Eliminar solo el archivo:** elimina la copia de trabajo y la miniatura y libera espacio. La entrada con fecha, nombre e historial se mantiene; el archivo se puede recuperar más tarde desde su fuente.",
            "**Eliminar y quitar de la base de datos:** elimina el archivo, la entrada y todas sus entradas del historial. Es definitivo y solo es posible para archivos en la papelera.",
          ],
        },
        { p: "Los dos niveles de eliminación piden confirmación." },
      ],
    },
    "verw-duplikate": {
      title: "La pestaña «Duplicados»: revisar todo el stream",
      blocks: [
        { p: "**Comprobar duplicados ahora** busca en todo el stream archivos con la misma huella; útil para archivos añadidos antes de activar la detección de duplicados. La comprobación continúa aunque se cambie de pestaña." },
        { p: "El resultado («12 posibles duplicados en 5 grupos») queda debajo del botón, junto con el botón **Enviar a Operaciones con archivos**. Allí se ven todos los archivos implicados; los sobrantes se marcan y se quitan. La app nunca decide qué versión se queda." },
        { p: "**Buscar imágenes parecidas** encuentra además fotos que se ven iguales sin ser el mismo archivo: copias reducidas, recomprimidas por WhatsApp o guardadas de nuevo. Para ello cada foto recibe una huella de imagen a partir de su miniatura. Las imágenes casi de un solo color, como cielos, paredes o tomas oscuras, quedan fuera, igual que las imágenes con muy poca estructura. Un grupo reúne las imágenes que se parecen a su primera imagen; por eso una serie larga de tomas parecidas da varios grupos pequeños. La primera búsqueda tarda más, porque cada foto recibe entonces su huella. También aquí el resultado llega como mensaje con **Enviar a Operaciones con archivos**, y sigue siendo una sugerencia." },
      ],
    },
    "verw-sicherung": {
      title: "Crear una copia de seguridad",
      blocks: [
        { p: "🛠 **Gestionar** › **Copia de seguridad** › **Crear copia de seguridad** y luego una carpeta de destino. Una ventana de progreso muestra «n de m archivos copiados»; **Cancelar** limpia lo que quedó a medias." },
        { p: "El resultado es una carpeta con el nombre del stream y una marca de tiempo: archivos, miniaturas, base de datos e historial. La copia es en sí misma un stream completo. Para volver a ella se usa **Restaurar y papelera…** › **Restaurar desde copia de seguridad** en la pantalla de inicio: crea una copia nueva y la abre (también se puede abrir directamente con **Abrir carpeta de stream**)." },
        { p: "El destino no puede estar dentro de la propia carpeta del stream." },
        { p: "**Actualizar una copia de seguridad existente…** pone al día una copia anterior en lugar de copiarlo todo de nuevo: se elige la carpeta de la copia; solo se copian los archivos nuevos y cambiados, junto con el estado actual de la base de datos. Los archivos que ya no existen en el stream se conservan en la copia, así que una foto borrada por error sigue allí. Una carpeta que no es una copia de este stream se rechaza. Si la carpeta contiene cambios que este stream no tiene (por ejemplo un duplicado que se ha continuado por separado) o pertenece a un stream con otro nombre, la aplicación pregunta antes. La base de datos anterior de la carpeta se conserva en ella como «cronostream.db.vor-aktualisierung»." },
      ],
    },
    "verw-archiv": {
      title: "Comprobar integridad: ¿siguen intactos todos los archivos?",
      blocks: [
        { p: "🛠 **Gestionar** › **Comprobar integridad** › **Comprobar integridad** revisa si todo sigue completo. La comprobación solo lee y no cambia nada en los archivos." },
        {
          list: [
            "**Archivos que faltan:** están en la línea de tiempo o adjuntos a una entrada del diario, pero faltan en la carpeta del stream. Los de la línea de tiempo se pueden volver a traer de su origen desde el historial o la papelera, si este todavía existe.",
            "**Miniaturas que faltan:** se recuperan con **Volver a crear miniaturas**, todas de una vez. Después, una comprobación rápida muestra el estado nuevo sin volver a leer los archivos completos.",
            "**Archivos sin entrada:** están en la carpeta del stream pero no pertenecen a ninguna entrada, por ejemplo restos de una copia interrumpida. La aplicación no los borra.",
            "**Contenidos cambiados:** solo con **Leer los contenidos completos**. La primera vez cada archivo recibe una huella; en comprobaciones posteriores se nota si un archivo ha cambiado sin que la aplicación lo cambiara, por ejemplo por un daño del disco. Una copia de seguridad o el origen probablemente todavía tienen la versión correcta.",
          ],
        },
        { p: "Leerlo todo completo tarda bastante en colecciones grandes. Conviene hacerlo de vez en cuando, por ejemplo antes de actualizar una copia de seguridad." },
      ],
    },

    // ---------- Historial ----------
    "log-ueberblick": {
      title: "Qué registra el historial",
      blocks: [
        { p: "🛠 **Gestionar** › **Historial** enumera cada acción, la más reciente primero: añadir, quitar, eliminar definitivamente, cambiar nombre, cambios de fecha (a mano y por IA), reemplazar, cambios de ajustes de este stream y todos los cambios en áreas temáticas y fases." },
        {
          list: [
            "**Buscar en el historial:** encuentra entradas por el nombre del archivo en el momento de la acción.",
            "**Desplegar:** una acción en lote como «147 archivos añadidos» muestra cada archivo con antes → después.",
            "**Vista previa:** al detenerse sobre un nombre de archivo aparece la imagen.",
            "**Cargar más entradas** al final trae las más antiguas.",
          ],
        },
      ],
    },
    "log-rueckgaengig": {
      title: "Deshacer un cambio",
      blocks: [
        {
          steps: [
            "Buscar la entrada en el historial y hacer clic en **Deshacer**, o en **Deshacer todo** en las acciones en lote. En una entrada desplegada también hay un botón por archivo.",
            "Si el mismo archivo se ha cambiado de nuevo desde entonces, aparece «Este archivo ha cambiado desde entonces» con los cambios más recientes. **Deshacer primero los cambios más recientes** los revierte también, en el orden correcto. Nada se sobrescribe sin avisar.",
            "Al deshacer una importación, CronoStream pregunta si conservar o eliminar la copia de la carpeta del stream. Los originales están a salvo en cualquier caso.",
          ],
        },
        { p: "Las entradas deshechas quedan marcadas como tales. Si falta la copia de trabajo, CronoStream recupera el archivo de su fuente original mientras esta exista." },
      ],
    },
    "log-endgueltig": {
      title: "Eliminar definitivamente en el historial",
      blocks: [
        { p: "Para archivos quitados cuya copia de trabajo sigue en la carpeta del stream, el historial ofrece casillas (**Seleccionar todo** / **Deseleccionar todo**) y el botón rojo **Eliminar definitivamente**. Elimina la copia de trabajo y la miniatura y libera espacio, tras una confirmación." },
        { note: "No se puede deshacer. La entrada sigue visible como «Eliminado definitivamente»." },
      ],
    },

    // ---------- Diario y grabaciones ----------
    "tb-anlegen": {
      title: "Escribir una entrada de diario",
      blocks: [
        { p: "El símbolo del diario en la barra superior inicia una entrada con la hora actual; clic derecho en un hueco libre › **Añadir entrada de diario aquí** la fecha en el punto del clic. La fecha y la hora se pueden cambiar en el diálogo." },
        {
          list: [
            "Escribir en el campo de texto.",
            "Adjuntos: **Añadir archivos**, arrastrar archivos a la ventana, **Imagen del portapapeles** o Ctrl+V. La × de una tarjeta de adjunto lo quita.",
            "**Guardar** o Ctrl+Intro guarda la entrada. Sin texto y sin adjuntos no se puede guardar.",
            "Con cambios sin guardar, Esc o cerrar pregunta antes (**Seguir editando** / **Descartar**).",
          ],
        },
      ],
    },
    "tb-lesen": {
      title: "Leer y editar entradas de diario",
      blocks: [
        { p: "Las entradas aparecen en la pista de documentos con su primera línea, la fecha y el número de adjuntos. Un clic abre la entrada para leerla; **Editar** (o el lápiz de la ficha), para cambiarla. Un clic en un adjunto lo abre en su programa predeterminado." },
        { p: "Si una entrada tiene varios adjuntos visibles, **Mostrar archivos** los muestra como clúster, y después se vuelve a abrir la entrada. Una entrada nueva queda en el historial como una importación y se puede deshacer. La búsqueda encuentra también el texto de las entradas de diario." },
      ],
    },
    "aufn-aufnehmen": {
      title: "Grabar vídeo o audio",
      blocks: [
        {
          steps: [
            "Hacer clic en 🎬 (vídeo) o 🎙️ (audio) en la barra superior. Si hay varios dispositivos conectados, elegir arriba **Cámara** y **Micrófono**; se recuerda la última elección.",
            "**Iniciar grabación**. Un punto rojo late y el tiempo corre. **Pausa** / **Continuar** cuando haga falta.",
            "**Detener grabación** y revisar el resultado en el reproductor.",
            "Escribir un **Nombre de la grabación** y pulsar **Añadir al stream**, o **Descartar y grabar de nuevo**.",
          ],
        },
        { p: "La grabación aparece en la línea de tiempo con el momento actual; su origen de fecha es «Grabado»." },
      ],
    },
    "aufn-ffmpeg": {
      title: "¿Qué hacer si falta ffmpeg?",
      blocks: [
        { p: "Para grabar, CronoStream necesita el programa libre ffmpeg. En Windows y macOS viene incluido en la instalación; si no se encuentra allí, reinstalar CronoStream lo soluciona." },
        { p: "El AppImage de Linux incluye ffmpeg con todos los decodificadores de vídeo y audio, así que no hace falta instalar nada. Otras instalaciones de Linux usan el ffmpeg del sistema. Si falta, el diálogo de grabación ofrece **Instalar ffmpeg** mediante el gestor de paquetes (se pide la contraseña del sistema) o muestra un comando para la terminal. Después, **Comprobar de nuevo**." },
      ],
    },

    // ---------- Áreas temáticas ----------
    "ph-verwalten": {
      title: "Crear áreas temáticas y fases",
      blocks: [
        { p: "El símbolo **Áreas temáticas** de la barra superior abre el diálogo. Un área temática (p. ej. «Trabajo» o «Lugares de residencia») agrupa fases como «Universidad» o «Vivir en Berlín»." },
        {
          list: [
            "**Crear área temática** y escribir un nombre. **Añadir fase** crea dentro una fila de borrador con los campos de fecha vacíos; la fase solo se guarda cuando se rellenan **Inicio** y **Fin**.",
            "Cada fase tiene título, **Inicio** y **Fin** (campo de fecha), la casilla **en curso** (el fin es entonces siempre hoy) y un **Color** (paleta o valor hexadecimal, **Aplicar**). Una fase nueva recibe automáticamente un color que aún no se usa en ningún área temática.",
            "**Ojo:** muestra u oculta una fase o un área temática entera. Medio lleno significa que solo algunas fases son visibles.",
            "**Permitir solapamiento** se define por área temática y viene activado de fábrica en las nuevas. Si está desactivado, una fase que se solape no se guarda y se nombran las fases afectadas.",
            "**Contraer:** la flecha a la izquierda de un área temática oculta sus fases de la lista; solo quedan visibles el nombre y el número de fases. El estado se recuerda; **Añadir fase** vuelve a expandir el área.",
            "**Orden** (selector de arriba): **Editadas recientemente** (de fábrica) pone arriba el área editada más recientemente, **Manual** muestra el orden guardado como en la línea de tiempo. Cuentan como edición crear, renombrar, solapamiento y todos los cambios de fases, no el ojo.",
            "**Reordenar** (solo con orden **Manual**): arrastrar por el asa de la izquierda, o Alt+↑/↓. La línea de tiempo conserva siempre el orden manual.",
            "**Quitar fase** o **Quitar área temática** con el botón al final de la fila.",
          ],
        },
        { p: "Todos los cambios se aplican al momento y se pueden deshacer en el historial. Mostrar y ocultar se guarda, pero no se registra." },
      ],
    },
    "ph-zeitleiste": {
      title: "Fases en la línea de tiempo",
      blocks: [
        { p: "Las fases son barras de color en una banda sobre las pistas, una fila por área temática; las fases solapadas se apilan. Al detenerse sobre una barra se muestra su periodo." },
        {
          list: [
            "**Clic en una barra:** acerca de modo que toda la fase llena la ventana. **↩ Volver** abajo a la izquierda o Esc vuelve a la vista anterior, mientras no se haya hecho zoom o desplazado a mano entretanto.",
            "**Clic derecho en una barra:** **Cambiar nombre**, **Cambiar color**, **Ocultar fase**, **Quitar fase**.",
            "**Menú de flecha a la izquierda de la banda:** mostrar y ocultar áreas temáticas rápidamente.",
          ],
        },
      ],
    },

    // ---------- Ajustes ----------
    "set-aufbau": {
      title: "Los ajustes: estructura y categorías",
      blocks: [
        { p: "⚙ abre los ajustes. A la izquierda hay una barra de **categorías** y a la derecha los ajustes de la categoría elegida. La última categoría elegida se conserva durante la sesión, también tras cambiar de idioma." },
        {
          list: [
            "**Sistema e idioma:** idioma de la interfaz, apariencia (esquema de colores **Claro** u **Oscuro**, oscuro de fábrica; vale para todo el equipo; la bandeja y el icono del programa lo siguen; también se cambia arriba a la derecha en la pantalla de inicio), inicio (pantalla de bienvenida, menú de inicio, escritorio, bandeja, inicio automático) y desinstalar.",
            "**Archivos y duplicados:** copia de trabajo al quitar, detección de duplicados, año más antiguo, acceso directo al administrador de duplicados.",
            "**Línea de tiempo y pistas:** orden de las pistas, cambiar la fecha arrastrando fichas, vista previa en miniatura de la línea de tiempo.",
            "**Pilas y zoom:** activador, acción y freno de zoom de las pilas, el puntero sigue la pila desplegada.",
            "**Medios y vista de detalle:** navegación en la vista de detalle, fecha como superposición, miniatura de vídeo.",
            "**Privacidad:** el modo privado.",
            "**Acerca de CronoStream:** versión, derechos de autor y licencias.",
          ],
        },
        { p: "Los interruptores y los campos de selección (botones contiguos de los que uno está elegido) surten efecto al instante. En el año más antiguo se confirma con Intro o al salir del campo («✓ Guardado»); en la miniatura de vídeo, con **Aplicar**. Un símbolo a la derecha del ajuste indica dónde se aplica la elección (véase «Dónde se aplica un ajuste»)." },
      ],
    },
    "set-sprache": {
      title: "Cambiar el idioma de la interfaz",
      blocks: [
        {
          steps: [
            "Abrir **⚙ Ajustes**.",
            "En la categoría **Sistema e idioma**, en la fila **Idioma**, elegir el idioma: **Deutsch**, **English** o **Español**.",
          ],
        },
        { p: "También funciona en la pantalla de inicio, incluso antes del primer stream: arriba a la derecha, junto a la taza de café, están los botones **Deutsch**, **English** y **Español**, además de **Claro** y **Oscuro** para el esquema de colores. La elección es la misma que en los ajustes." },
        { p: "La interfaz cambia de inmediato, sin necesidad de reiniciar. Los ajustes permanecen abiertos. Cada idioma aparece escrito en su propia lengua, así se encuentra aunque no se entienda el idioma actual." },
        { p: "En el primerísimo inicio la interfaz sigue el idioma del sistema operativo (alemán, inglés o español); si no, se usa inglés. Una elección guardada siempre tiene prioridad." },
        {
          list: [
            "La elección se aplica a todos los streams de este ordenador, también a la pantalla de inicio y a la **Bandeja**. Por eso aquí no hay «Se aplica a».",
            "Con el idioma cambian también los formatos de fecha y hora, la ayuda, los mensajes del programa, la imagen de la línea de tiempo vacía y los nombres de archivo de **Exportar para imprimir**.",
            "El contenido no cambia: nombres, notas, entradas del diario, etapas de la vida y los propios archivos no se traducen.",
          ],
        },
      ],
    },
    "set-geltung": {
      title: "Dónde se aplica un ajuste (chincheta y globo)",
      blocks: [
        { p: "Muchos ajustes llevan a la derecha un pequeño símbolo que indica dónde se aplican: **chincheta** = solo este stream, **globo** = todos los streams de este equipo. Un clic en él abre una pequeña ventana con dos opciones (Esc cierra solo esa ventana):" },
        {
          list: [
            "**Este stream:** solo en el stream abierto; los demás conservan su propia elección. Los cambios quedan en el historial de este stream y se pueden deshacer.",
            "**Todos:** para todos los streams de este ordenador. Al cambiar, se adopta el valor actual; no cambia por cambiar el ámbito.",
          ],
        },
        { p: "No hay símbolo en las categorías **Sistema e idioma** y **Acerca de CronoStream**, porque allí todo se aplica a todo el equipo, ni en **Privacidad**, que siempre se aplica solo a su propio stream." },
        { p: "Por defecto, cada ajuste se aplica solo a su propio stream. Así un stream de fotos puede comportarse distinto que uno de documentos. La mayoría de los ajustes se aplican al instante." },
      ],
    },
    "set-allgemein": {
      title: "Ajustes: Archivos y duplicados",
      blocks: [
        {
          list: [
            "**Eliminar la copia de trabajo al quitar** (desactivado por defecto): al quitar un archivo se elimina también su copia en la carpeta del stream. Atención: quitar es entonces definitivo y no pasa por la papelera; por eso la vista de detalle y las operaciones con archivos preguntan antes. Los originales no se tocan.",
            "**Detectar duplicados automáticamente al importar** (activado): compara los archivos nuevos con la colección y señala los sospechosos para revisarlos.",
            "**Comprobación rápida por nombre y tamaño** (activado, subopción): solo comprueba cuando ya existe un archivo con el mismo nombre y tamaño. Desactivada, encuentra también duplicados renombrados; tarda más.",
            "**Año más antiguo para fechas** (1900): en cualquier campo de fecha se rechazan los años anteriores, y las fechas futuras siempre.",
            "**Ir al Administrador de Duplicados →:** abre la pestaña Duplicados.",
          ],
        },
      ],
    },
    "set-zeitleiste": {
      title: "Ajustes: Línea de tiempo y pistas",
      blocks: [
        {
          list: [
            "**Orden de pistas y visibilidad:** las pistas se reordenan arrastrando el asa ⋮⋮ o con los botones de flecha. **Restablecer orden predeterminado** lo restablece. Las pistas sin contenido se ocultan automáticamente.",
            "**Cambiar fecha arrastrando fichas** (desactivado): las fichas se pueden arrastrar en horizontal a una fecha nueva. Desactivado, arrastrar desplaza la línea de tiempo.",
            "**Vista previa en miniatura de la línea de tiempo** (por defecto solo Operaciones con archivos): un interruptor por vista de la caja de herramientas para mostrar u ocultar la vista previa flotante y su botón de regreso.",
          ],
        },
      ],
    },
    "set-stapel": {
      title: "Ajustes: Pilas y zoom",
      blocks: [
        {
          list: [
            "**Activador de pila:** **Puntero del ratón (Hover)** abre al detenerse, **Clic** (por defecto) solo con un clic. Un clic siempre resuelve una pila, sea cual sea este ajuste.",
            "**Acción al abrir pila:** **Acercar en la línea de tiempo** acerca hasta que la pila se deshace en fichas individuales. **Desplegar pila (abanico)** (por defecto) muestra la cuadrícula en el sitio sin cambiar el zoom.",
            "**Freno de zoom al mantener el ratón:** solo actúa con hover + acercar. **Paso a paso** se detiene tras cada paso hasta que se mueve el ratón. **Continuo** sigue acercando mientras el puntero esté quieto. **Solo mediante clic** (por defecto) despliega al detenerse y solo acerca con un clic. Si el freno no actúa en ese momento, aparece atenuado con una nota y se puede configurar igualmente por adelantado.",
            "**El puntero sigue la pila desplegada** (interruptor, desactivado por defecto): al desplegar una pila, el puntero salta a la ficha central, cuyo archivo se muestra grande arriba. Ayuda con las pilas del borde. Solo actúa cuando una pila se despliega (con «Acercar en la línea de tiempo» solo si el zoom ya no basta para deshacerla) y solo donde el sistema de ventanas lo permite: X11, Windows y macOS, no en una sesión Wayland pura.",
            "**Niveles de zoom:** los interruptores **Mostrar cuadrícula de semanas** y **Mostrar cuadrícula de horas** (ambos activados por defecto) determinan qué niveles de cuadrícula muestra la línea de tiempo. Sin la cuadrícula de semanas, la de días empieza en cuanto un mes llena la ventana; sin la de horas, se queda en la de días por mucho que se amplíe.",
            "**La rueda del ratón abre y cierra la vista de detalle** (interruptor, activado por defecto): un paso de la rueda hacia delante sobre la vista previa grande de una pila desplegada abre el archivo, como un clic. En la vista de detalle hacen falta unos tres pasos hacia atrás seguidos para cerrarla; una pausa de más de 0,6 segundos o un paso hacia delante reinicia la cuenta. Cuando una imagen ampliada vuelve al marco al alejar, el mismo movimiento no cierra además la vista de detalle; los pasos hacia atrás solo cuentan de nuevo tras 0,7 segundos de pausa. Con la imagen ampliada y sobre contenidos que se desplazan solos (documentos, textos), el desplazamiento no cuenta. Después la rueda no actúa un momento sobre la línea de tiempo ni el zoom de imagen.",
          ],
        },
      ],
    },
    "set-medien": {
      title: "Ajustes: Medios y vista de detalle",
      blocks: [
        {
          list: [
            "**Navegación en la vista de detalle:** **Solo la misma categoría** (de foto en foto), **Todos los medios** (por defecto, cronológico por todas las pistas) o **Personalizado** con interruptores para imágenes, vídeos, audios y documentos.",
            "**Mostrar fecha como superposición** (activado): fecha y hora discretas en el borde inferior de la vista de detalle.",
            "**Miniatura de vídeo:** posición en porcentaje de la duración del vídeo (10 por defecto). **Aplicar** la usa para vídeos nuevos. **Volver a generar las miniaturas de vídeo existentes ahora** renueva además todas las existentes.",
          ],
        },
      ],
    },
    "set-start": {
      title: "Inicio: bienvenida, menú de inicio y inicio automático",
      blocks: [
        { p: "⚙ › **Sistema e idioma** › **Inicio** reúne ajustes de la propia app. Valen para todo el equipo, por eso aquí no hay «Se aplica a»." },
        {
          list: [
            "**Mostrar pantalla de bienvenida:** muestra la breve introducción cada vez que se abre la ventana principal. En la ventana de bienvenida, **No volver a mostrar** la desactiva; aquí se puede volver a activar.",
            "**Entrada en el menú de inicio para CronoStream:** inicia el programa principal desde el menú de inicio.",
            "**Entrada en el menú de inicio para la bandeja:** abre solo la bandeja como pequeño círculo, sin ventana principal.",
            "**Abrir la bandeja al iniciar el sistema:** abre la bandeja automáticamente como pequeño círculo tras iniciar sesión.",
            "**Acceso directo en el escritorio** (desactivado de fábrica): coloca CronoStream como icono en el escritorio. En Linux, el lanzador queda directamente ejecutable y marcado como de confianza.",
          ],
        },
        { p: "Los cuatro interruptores del menú de inicio, el inicio automático y el escritorio solo aparecen en el AppImage de Linux y en la versión instalada de Windows, y funcionan igual en ambos. En el primer inicio, la ventana de bienvenida ofrece además elegir la **Apariencia** (Claro u Oscuro) mientras no haya ninguna guardada; **Empezar** guarda la preselección. Los interruptores los ofrece una vez (**Configuración en este equipo**); las entradas que ya existen, por ejemplo las del instalador de Windows, se conservan. Después se pueden cambiar aquí." },
        { p: "En Linux, las entradas del menú de inicio están en la carpeta de menú **CronoStream**, junto con **Desinstalar CronoStream**. En Windows, el instalador crea una carpeta en el menú de inicio (su nombre se elige en una página propia del instalador, **CronoStream** de fábrica) con el programa, **CronoStream Bandeja** y **Desinstalar CronoStream**. El instalador y el desinstalador están en alemán, inglés o español según el idioma de Windows, si no en inglés, y las entradas se llaman en consecuencia. En Windows, una entrada desactivada solo se aparta y se recupera al activarla de nuevo; si falta del todo, se crea de nuevo." },
        { p: "**Carpeta vigilada** (⚙ › **Sistema e idioma**): se vigila una carpeta elegida. Los archivos nuevos que aparezcan en ella pasan automáticamente a la bandeja, incluso con la ventana principal cerrada, mientras la bandeja esté activa. Los archivos ya existentes no se incorporan. **Incluir subcarpetas** incorpora también archivos de subcarpetas. Los archivos sin terminar (como .part o .tmp) solo se incorporan cuando termina la escritura. Si la carpeta no está accesible (unidad desconectada), la vigilancia continúa en cuanto vuelva. **Dejar de vigilar** la termina." },
      ],
    },

    "set-deinstallieren": {
      title: "Quitar CronoStream por completo",
      blocks: [
        { p: "⚙ › **Sistema e idioma** › **Desinstalar** › **Quitar…** o la entrada del menú de inicio **Desinstalar CronoStream** abre un diálogo. Enumera todo lo que CronoStream ha creado en este ordenador fuera de los streams: ajustes, lista de streams, lista de espera de la bandeja, índice de búsqueda y archivo de registro, datos guardados de la interfaz, memorias caché, grabaciones aún no añadidas, entradas del menú de inicio, de la carpeta de menú y del inicio automático, y restos con el antiguo nombre LifeStream. Tras **Quitar ahora** y una última confirmación, todo ello se elimina y la aplicación se cierra." },
        {
          list: [
            "**Los streams** se conservan. Solo los streams marcados uno a uno se eliminan definitivamente junto con su carpeta; de fábrica no hay ninguno marcado. Los streams que no figuran en la lista de streams no se tocan.",
            "**Eliminar también el archivo del programa** (solo Linux, desactivado de fábrica): elimina además el archivo AppImage. Sin marcar, el archivo se queda donde está y se puede volver a iniciar o eliminar a mano más tarde.",
            "**Windows:** a continuación se inicia el desinstalador de Windows sin más preguntas y quita el propio programa.",
          ],
        },
        { p: "En Windows, CronoStream también se puede desinstalar como de costumbre desde la configuración de Windows (Aplicaciones). El desinstalador quita entonces el programa, la carpeta del menú de inicio, el acceso directo del escritorio y el inicio automático; con la opción de borrar los datos de la aplicación, también los ajustes y las memorias caché. Los streams se conservan siempre." },
        { note: "Los datos de la aplicación también contienen los historiales guardados de los streams eliminados. Después de quitar CronoStream, esos streams ya no se pueden restaurar." },
      ],
    },

    "set-privat": {
      title: "Modo privado: ocultar archivos",
      blocks: [
        { p: "El modo privado oculta los archivos cuya nota contiene un texto determinado. Solo se vuelven a mostrar tras introducir una contraseña. Se aplica por stream y se configura en ⚙ › **Privacidad**." },
        { note: "Es una protección visual dentro de la aplicación, no un cifrado: los archivos permanecen intactos en la carpeta del stream. Las copias de seguridad siempre contienen todos los archivos, también los ocultos." },
        { p: "**Configurar**" },
        {
          steps: [
            "Abrir ⚙ › **Privacidad**.",
            "Introducir la **Contraseña** y repetirla (mínimo 4 caracteres).",
            "Elegir **Grabar combinación** y pulsar la combinación de teclas deseada: Ctrl y una letra, salvo las habituales como C, V o X. También se pueden usar dos teclas especiales, como Ctrl+Mayús y una letra. Necesita Ctrl o Alt y una tecla más; las combinaciones ya ocupadas, como Ctrl+F, se rechazan, y Esc cancela. Para comprobarla se ve una vez en texto claro; tras **Aceptar** queda ilegible. **Mostrar** y **Ocultar** alternan la visualización en texto claro en los ajustes.",
            "Definir el **Texto de la nota**: un archivo se considera privado si su nota contiene este texto. No importan las mayúsculas ni minúsculas.",
            "Elegir el alcance en **Dónde se ocultan** (véase abajo). En **Volver a ocultar automáticamente** se puede indicar un número de minutos sin actividad; 0 significa desactivado (de fábrica). La casilla **Mostrar el icono en la esquina inferior izquierda** (activada de fábrica) muestra u oculta el ojo.",
            "Elegir **Configurar el modo privado**. A continuación aparece una sola vez el **Código de recuperación**. Debe guardarse en un lugar seguro; **Código anotado** termina la configuración.",
          ],
        },
        { p: "**Alcance**" },
        {
          list: [
            "**Solo en la línea de tiempo:** la línea de tiempo y su búsqueda no muestran los archivos privados. En las listas de archivos siguen siendo localizables.",
            "**Solo en las vistas** (de fábrica): la línea de tiempo, la búsqueda y las listas de archivos no los muestran. El historial sigue enumerándolos.",
            "**En todas partes:** además tampoco aparecen en el historial ni en las exportaciones. Las copias de seguridad siguen completas.",
          ],
        },
        { p: "**En el uso diario**" },
        {
          list: [
            "**Ocultar:** pulsar la combinación de teclas. Surte efecto al instante.",
            "**Mostrar:** pulsar la misma combinación, introducir la **Contraseña** y elegir **Mostrar**.",
            "Tras cada apertura del stream, los archivos privados están ocultos. Con **Volver a ocultar automáticamente** se ocultan de nuevo pasado el tiempo indicado sin actividad.",
            "La combinación funciona en cada vista y diálogo del stream abierto.",
            "El **símbolo de abajo del todo a la izquierda** muestra el estado: ojo = todos los archivos visibles, ojo tachado = archivos privados ocultos. Se puede desactivar en los ajustes con **Mostrar el icono en la esquina inferior izquierda**; entonces la ventana no indica si hay archivos ocultos en ese momento.",
          ],
        },
        { p: "**Cambiar ajustes, contraseña olvidada, desactivar**" },
        {
          list: [
            "La sección solo se puede ver y modificar con la contraseña: **Desbloquear**. **Bloquear** la cierra de nuevo.",
            "Desbloqueada, se pueden cambiar el texto de la nota, el alcance, el ocultado automático y el icono (**Guardar cambios**), además de **Cambiar contraseña** y **Grabar de nuevo** la combinación.",
            "**¿Contraseña olvidada?** lleva a **Establecer nueva contraseña**, para lo que hace falta el código de recuperación. Después queda gastado y se muestra uno nuevo.",
            "**Desactivar el modo privado** elimina la contraseña, la combinación y el texto de la nota. Todos los archivos vuelven a ser visibles; las notas se conservan.",
          ],
        },
      ],
    },
    "set-ueber": {
      title: "Acerca de CronoStream y licencias",
      blocks: [
        { p: "Al final de los ajustes aparecen la versión, los derechos de autor y el aviso de que CronoStream es software libre bajo la licencia EUPL-1.2 (gratuito y sin garantía, con enlace al código fuente). **Ver licencias de código abierto** abre bajo «Licencias» una lista con búsqueda que empieza por CronoStream mismo y abarca todos los componentes usados; un clic muestra el texto completo de la licencia." },
        { p: "La **taza de café** (descripción «Invítame a un café») en la cabecera, entre ? y pantalla completa, y arriba a la derecha en la pantalla de inicio, abre la página de donaciones en el navegador." },
        { p: "**Actualizaciones:** de fábrica, CronoStream consulta como mucho una vez al día en felixheck.de si existe una versión más nueva (un archivo pequeño por HTTPS; solo se transmite la dirección IP, nada sobre el equipo, los archivos o los streams). Si la hay, aparece una vez por versión un aviso con **Descargar**; no se instala nada por sí solo. Sin conexión, la comprobación se queda en silencio. El interruptor **Buscar actualizaciones automáticamente** la desactiva (por equipo), **Buscar ahora** consulta al instante y avisa también si no hay conexión." },
      ],
    },

    // ---------- Teclado y ratón ----------
    "keys-allgemein": {
      title: "Atajos en la línea de tiempo",
      blocks: [
        {
          keys: [
            ["Rueda del ratón", "Zoom (anclado en el puntero)"],
            ["Arrastrar", "Desplazar la línea de tiempo"],
            ["Clic", "Abrir un archivo o resolver una pila"],
            ["Ctrl+clic", "Marcar una ficha"],
            ["Ctrl+A", "Marcar todas las fichas visibles (en un clúster: su contenido)"],
            ["Ctrl+F", "Abrir la búsqueda"],
            ["Intro / Mayús+Intro", "Resultado siguiente / anterior"],
            ["Ctrl+V", "Imagen del portapapeles como entrada de diario"],
            ["Clic derecho", "Menú de una ficha, un hueco libre o una barra de fase"],
            ["Combinación propia", "Ocultar y mostrar archivos privados (⚙ › Privacidad)"],
            ["Esc", "Cerrar la capa superior: zoom de imagen › vista de detalle › clúster › pila › búsqueda › selección › zoom de fase. También sale de la pantalla completa."],
          ],
        },
      ],
    },
    "keys-detail": {
      title: "Atajos en la vista de detalle",
      blocks: [
        {
          keys: [
            ["← / →", "Archivo anterior / siguiente"],
            ["Supr", "Quitar el archivo y pasar al siguiente"],
            ["+ / −, rueda", "Ampliar / reducir la imagen"],
            ["Arrastrar", "Mover la imagen ampliada"],
            ["Alt+arrastrar", "Arrastrar la imagen ampliada a otro programa"],
            ["Intro / Esc", "Aplicar / cancelar el campo de nombre o de fecha"],
            ["Esc", "Salir del zoom o cerrar la vista de detalle"],
          ],
        },
      ],
    },
    "keys-browser": {
      title: "Atajos en el explorador y en los diálogos",
      blocks: [
        {
          keys: [
            ["Flechas", "Vista general/operaciones con archivos: moverse por la cuadrícula"],
            ["Espacio / doble clic", "Marcar un archivo"],
            ["Ctrl+A", "Marcar todos los archivos (en operaciones con archivos y papelera: otra vez = desmarcar)"],
            ["→ / ← / Retroceso", "Imagen individual: avanzar y retroceder"],
            ["Ctrl+Intro", "Guardar una entrada de diario"],
            ["Ctrl+V", "Editor del diario: pegar una imagen como adjunto"],
            ["Alt+↑ / ↓", "Áreas temáticas: reordenar un área"],
            ["Intro", "Diálogos con campo de nombre: confirmar"],
            ["Esc", "Cerrar un diálogo, un menú o el centro de ayuda"],
          ],
        },
        { p: "Las teclas del campo de fecha están en el tema «Usar el campo de fecha»." },
      ],
    },

    // ---------- Preguntas frecuentes ----------
    "faq-mehrere": {
      title: "¿Se pueden tener varios streams abiertos a la vez?",
      blocks: [
        { p: "Una ventana tiene siempre exactamente un stream abierto. Con ← arriba a la izquierda se vuelve a la pantalla de inicio, donde se puede abrir otro. El mismo stream nunca puede estar abierto en dos ventanas a la vez, lo que protege la base de datos; en ese caso aparece el mensaje «Ya está abierto»." },
      ],
    },
    "faq-datum-name": {
      title: "¿Qué diferencia hay entre cambiar la fecha y cambiar el nombre?",
      blocks: [
        { p: "Cambiar la fecha mueve el archivo en la línea de tiempo. Cambiar el nombre solo cambia el nombre mostrado en CronoStream. Ninguna de las dos cosas modifica el archivo en el disco. Para nombres de archivo con fecha y hora existe la **Exportación para impresión**." },
      ],
    },
    "faq-entfernen": {
      title: "Quitar, «Eliminar solo el archivo», eliminar definitivamente: ¿qué es cada cosa?",
      blocks: [
        {
          list: [
            "**Quitar:** saca el archivo de la línea de tiempo a la papelera. Totalmente reversible (papelera o historial).",
            "**Eliminar solo el archivo** (papelera): libera el espacio de la copia de trabajo pero conserva la entrada. El archivo se puede recuperar de su fuente original.",
            "**Eliminar definitivamente** (historial) o **Eliminar y quitar de la base de datos** (papelera): no se puede deshacer.",
          ],
        },
        { p: "El original fuera de la carpeta del stream no se toca en ningún caso. Con **Eliminar la copia de trabajo al quitar**, quitar ya es definitivo." },
      ],
    },
    "faq-sicherung": {
      title: "Copia de seguridad, copia o exportación para impresión: ¿qué para qué?",
      blocks: [
        {
          list: [
            "**Copia de seguridad** (Gestionar): una copia completa con marca de tiempo, para guardarla o llevarla a otro sitio.",
            "**Copiarlo todo a un stream nuevo** (operaciones con archivos): una copia independiente con otro nombre, p. ej. para seguir trabajando por separado.",
            "**Exportación para impresión** (operaciones con archivos): solo las fotos elegidas, nombradas por fecha, para servicios de impresión.",
            "**Copiar a otro stream** (operaciones con archivos): los archivos elegidos, con sus datos, a otro stream.",
          ],
        },
      ],
    },
    "faq-mitnehmen": {
      title: "¿Cómo se lleva un stream a otro ordenador?",
      blocks: [
        { p: "Un stream es una carpeta normal. Basta con crear una **copia de seguridad** en un disco externo o un USB, o copiar la carpeta del stream cerrado. En el otro ordenador se abre en la pantalla de inicio con **Abrir carpeta de stream**. Si allí está en otra ruta, al abrirlo la aplicación pregunta «El stream se ha movido» y ajusta las rutas tras confirmarlo. Fechas, notas e historial están completos. «Mostrar en la carpeta de origen» y recuperar archivos de su fuente solo funcionan allí si los originales también son accesibles." },
      ],
    },
    "faq-formate": {
      title: "¿Qué tipos de archivo admite CronoStream?",
      blocks: [
        {
          list: [
            "**Imágenes:** JPG, PNG, GIF, BMP, WebP, TIFF",
            "**Vídeos:** MP4, MOV, MKV, WebM, AVI, WMV, FLV, 3GP, MPG",
            "**Audio:** MP3, WAV, M4A, FLAC, OGG, AAC, WMA, AIFF",
            "**Documentos:** PDF, DOCX, DOC, ODT, RTF, TXT (también en ANSI y UTF-16), CSV, XLS, XLSX, con búsqueda de texto",
            "**Correos:** EML y MSG de Outlook, con adjuntos y búsqueda de texto",
          ],
        },
        { p: "También se pueden añadir otros archivos. Aparecen sin vista previa en la pista de documentos y se abren en su programa predeterminado." },
      ],
    },
    "faq-duplikate": {
      title: "¿Cómo detecta CronoStream los duplicados?",
      blocks: [
        { p: "CronoStream crea para cada archivo una huella corta a partir de su tamaño y del principio y el final de su contenido. La misma huella significa un posible duplicado, incluso con otro nombre. Es rápido incluso con vídeos grandes." },
        {
          list: [
            "**Al añadir:** como tarjeta comparativa en la ventana de revisión. Si la importación encuentra después otro sospechoso, aparece un mensaje con **Enviar a Operaciones con archivos**.",
            "**Para toda la colección:** la pestaña **Duplicados** en Gestionar.",
            "**En la búsqueda en el disco:** **Ocultar duplicados** y **Ocultar archivos que ya están en el stream**, opcionalmente con comprobación exhaustiva del contenido.",
          ],
        },
        { p: "Se controla con los ajustes **Detectar duplicados automáticamente al importar** y **Comprobación rápida por nombre y tamaño**." },
      ],
    },
    "faq-lokal": {
      title: "¿Salen datos del ordenador?",
      blocks: [
        { p: "No. CronoStream funciona completamente en local, sin cuenta, nube ni subidas. Un pequeño servidor de medios interno solo entrega miniaturas a su propia interfaz y no es accesible desde fuera." },
        { p: "La única excepción es un paso manual y deliberado: en la datación con IA, los nombres de archivo, rutas y metadatos se copian a mano en un programa de IA libremente elegido, nunca el contenido de los archivos. Fuera del AppImage, en Linux el diálogo de grabación también puede instalar ffmpeg mediante el gestor de paquetes." },
        { p: "Dentro de la propia aplicación también se pueden ocultar archivos: el **modo privado** (⚙ › Privacidad) oculta con una combinación de teclas los archivos con un texto de nota determinado. Es una protección visual, no un cifrado." },
      ],
    },
    "faq-arbeitet": {
      title: "La app está trabajando: progreso y cancelación",
      blocks: [
        { p: "Las operaciones largas muestran arriba a la derecha una tarjeta de progreso con barra y el nombre del archivo actual; las esperas cortas, la píldora «Trabajando…» abajo a la derecha. Copiar, crear copias de seguridad y buscar en el disco se pueden cancelar; CronoStream limpia solo lo que quede a medias." },
        { p: "Los avisos aparecen como pequeñas tarjetas abajo en el centro, algunas con un botón de acción (p. ej. **Enviar a Operaciones con archivos**)." },
      ],
    },
  },
};
