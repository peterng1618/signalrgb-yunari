import QtQuick 2.15
import QtQuick.Controls 2.15
import QtQuick.Layouts 1.15

Item {
	anchors.fill: parent

	ColumnLayout {
		anchors.fill: parent
		anchors.margins: 12
		spacing: 10

		Text {
			text: "Yunari RGB bridge"
			color: theme.primarytextcolor
			font.family: "Poppins"
			font.pixelSize: 16
			font.bold: true
		}

		Text {
			text: "SignalRGB sends colours to Yunari over HTTP and UDP. Set the API host and port in the device settings. Yunari must be running, and SignalRGB's own Kraken plugin must be disabled."
			color: theme.primarytextcolor
			font.family: "Poppins"
			font.pixelSize: 12
			wrapMode: Text.WordWrap
			Layout.fillWidth: true
		}

		Button {
			text: "Refresh devices"
			onClicked: discovery.forceDiscover("")
		}
	}
}
